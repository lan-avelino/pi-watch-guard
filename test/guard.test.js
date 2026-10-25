import { test } from "node:test";
import assert from "node:assert/strict";
import watchGuard from "../extensions/watch-guard.js";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
const NOTIFY = "subagent-notify";

function createHost() {
  const handlers = new Map();
  const channels = new Map();
  const commands = new Map();

  const pi = {
    on(name, fn) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    events: {
      on(channel, fn) {
        let set = channels.get(channel);
        if (!set) {
          set = new Set();
          channels.set(channel, set);
        }
        set.add(fn);
        return () => set.delete(fn);
      },
      emit(channel, data) {
        for (const fn of [...(channels.get(channel) ?? [])]) fn(data);
      },
    },
  };

  return { pi, handlers, channels, commands };
}

function respondWithRuns(host, runs) {
  host.pi.events.on(RPC_REQUEST, (request) => {
    host.pi.events.emit(`${RPC_REPLY}${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      method: "status",
      success: true,
      data: { asyncSnapshot: { runs } },
    });
  });
}

const settleEvent = {
  type: "agent_before_settle",
  outcome: "completed",
  entries: [],
  continue: false,
};

const ctx = { hasPendingMessages: () => false };

const settle = (host) => host.handlers.get("agent_before_settle")(settleEvent, ctx);

const notify = (host) =>
  host.handlers.get("before_agent_start")({
    messageType: "custom",
    message: { role: "custom", customType: NOTIFY, content: "done", display: false },
  });

const enable = (host) => host.commands.get("watch-guard").handler("on", { ui: { notify() {} } });

test("off by default: a completion notice does not force a continuation", async () => {
  const host = createHost();
  watchGuard(host.pi);
  respondWithRuns(host, []);
  await notify(host);
  assert.equal(await settle(host), undefined);
});

test("on + no live run: forces one continuation with one custom message", async () => {
  const host = createHost();
  watchGuard(host.pi);
  respondWithRuns(host, []);
  await enable(host);
  await notify(host);

  const result = await settle(host);
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].type, "custom_message");
  assert.equal(result.entries[0].customType, "watch-guard");
});

test("on + a running run: no continuation", async () => {
  const host = createHost();
  watchGuard(host.pi);
  respondWithRuns(host, [{ id: "a", state: "running" }]);
  await enable(host);
  await notify(host);
  assert.equal(await settle(host), undefined);
});

test("on + only terminal runs: continuation", async () => {
  const host = createHost();
  watchGuard(host.pi);
  respondWithRuns(host, [
    { id: "a", state: "complete" },
    { id: "b", state: "stopped" },
  ]);
  await enable(host);
  await notify(host);
  const result = await settle(host);
  assert.equal(result.continue, true);
});

test("fires once per notice, never twice", async () => {
  const host = createHost();
  watchGuard(host.pi);
  respondWithRuns(host, []);
  await enable(host);
  await notify(host);

  const first = await settle(host);
  const second = await settle(host);
  assert.equal(first.continue, true);
  assert.equal(second, undefined);
});

test("aborted turn: no continuation", async () => {
  const host = createHost();
  watchGuard(host.pi);
  respondWithRuns(host, []);
  await enable(host);
  await notify(host);
  const result = await host.handlers.get("agent_before_settle")(
    { ...settleEvent, outcome: "aborted" },
    ctx
  );
  assert.equal(result, undefined);
});

test("queued user input: no continuation", async () => {
  const host = createHost();
  watchGuard(host.pi);
  respondWithRuns(host, []);
  await enable(host);
  await notify(host);
  const result = await host.handlers.get("agent_before_settle")(settleEvent, {
    hasPendingMessages: () => true,
  });
  assert.equal(result, undefined);
});

test("no pi-subagents reply: no continuation, error recorded", async () => {
  const host = createHost();
  watchGuard(host.pi);
  await enable(host);
  await notify(host);
  assert.equal(await settle(host), undefined);
});

test("a user turn does not arm the guard", async () => {
  const host = createHost();
  watchGuard(host.pi);
  respondWithRuns(host, []);
  await enable(host);
  await host.handlers.get("before_agent_start")({ messageType: "user", prompt: "hi" });
  assert.equal(await settle(host), undefined);
});

test("/watch-guard off clears the armed state", async () => {
  const host = createHost();
  watchGuard(host.pi);
  respondWithRuns(host, []);
  await enable(host);
  await notify(host);
  await host.commands.get("watch-guard").handler("off", { ui: { notify() {} } });
  assert.equal(await settle(host), undefined);
});
