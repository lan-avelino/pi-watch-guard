/**
 * watch-guard
 *
 * Forces one extra model turn when a turn that started from a subagent
 * completion notice ends while no subagent is running. The failure it
 * covers: a watch phase ends with the report, no replacement watcher is
 * started, so nothing can wake the session again.
 *
 * The check is mechanical. It asks pi-subagents for its async run status
 * over the in-process event bus, so it does not depend on the model
 * remembering to look.
 *
 * Off by default. Enable per session with `/watch-guard on`.
 */

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const NOTIFY_TYPE = "subagent-notify";
const GUARD_TYPE = "watch-guard";
const LIVE_STATES = new Set(["queued", "running"]);
const RPC_TIMEOUT_MS = 2000;

const CONTINUATION = [
  "watch-guard: this turn started from a subagent completion notice, and no subagent is running now.",
  "If a watch target is still unfinished, start one watcher in this turn with a stop condition and a budget.",
  "If the target is finished, name the line that proves it and end the turn.",
  "Do not start a watcher with no target.",
].join("\n");

/** Unique-enough id for the RPC correlation channel. */
function requestId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `wg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Ask pi-subagents for the current async status. Resolves null on timeout. */
function requestStatus(pi, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const id = requestId();
    let settled = false;
    let timer;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };

    const unsubscribe = pi.events.on(`${RPC_REPLY_PREFIX}${id}`, (reply) => finish(reply));
    timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    pi.events.emit(RPC_REQUEST, { version: 1, requestId: id, method: "status", params: {} });
  });
}

/** Count queued or running top-level runs. Returns null when the reply is unusable. */
function liveRunCount(reply) {
  if (!reply || reply.success !== true) return null;
  const runs = reply.data && reply.data.asyncSnapshot && reply.data.asyncSnapshot.runs;
  if (!Array.isArray(runs)) return null;
  return runs.filter((run) => run && LIVE_STATES.has(run.state)).length;
}

export default function watchGuard(pi) {
  const state = {
    enabled: false,
    armed: false,
    fired: false,
    lastLive: null,
    lastCheck: "",
    lastError: "",
  };

  const arm = () => {
    if (!state.enabled) return;
    state.armed = true;
    state.fired = false;
  };

  // A run started by a completion notice, or a notice appended mid-run.
  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "custom") return;
    if (!event.message || event.message.customType !== NOTIFY_TYPE) return;
    arm();
  });

  pi.on("message_end", (event) => {
    const message = event && event.message;
    if (!message || message.role !== "custom") return;
    if (message.customType !== NOTIFY_TYPE) return;
    arm();
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!state.enabled || !state.armed || state.fired) return;

    // The turn did not finish on its own, or the user already queued input.
    if (event.outcome !== "completed") {
      state.armed = false;
      return;
    }
    if (ctx && typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) {
      state.armed = false;
      return;
    }

    const reply = await requestStatus(pi);
    state.lastCheck = new Date().toISOString();

    const live = liveRunCount(reply);
    if (live === null) {
      state.lastError = reply
        ? "status reply was not usable"
        : `no reply from pi-subagents within ${RPC_TIMEOUT_MS} ms`;
      state.armed = false;
      return;
    }

    state.lastLive = live;
    state.lastError = "";
    state.armed = false;
    if (live > 0) return;

    state.fired = true;
    return {
      continue: true,
      entries: [
        {
          type: "custom_message",
          customType: GUARD_TYPE,
          content: CONTINUATION,
          display: true,
        },
      ],
    };
  });

  pi.registerCommand("watch-guard", {
    description: "Guard the watch loop: /watch-guard on|off|status (off by default)",
    handler: async (args, ctx) => {
      const command = String(args || "").trim().toLowerCase() || "status";

      if (command === "on") {
        state.enabled = true;
        state.armed = false;
        state.fired = false;
        ctx.ui.notify("watch-guard: on", "info");
        return;
      }

      if (command === "off") {
        state.enabled = false;
        state.armed = false;
        state.fired = false;
        ctx.ui.notify("watch-guard: off", "info");
        return;
      }

      if (command === "status" || command === "st") {
        const lines = [
          `watch-guard: ${state.enabled ? "on" : "off"}`,
          `armed: ${state.armed}  fired this wake: ${state.fired}`,
          `last check: ${state.lastCheck || "never"}  live runs: ${state.lastLive === null ? "unknown" : state.lastLive}`,
          `last error: ${state.lastError || "none"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      ctx.ui.notify("usage: /watch-guard on|off|status", "warning");
    },
  });
}
