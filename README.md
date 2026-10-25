# pi-watch-guard

A Pi extension for long host runs watched through subagents.

## The failure it covers

A session does no work while it has no open tool call and no running child. A watcher subagent returns, the parent writes its report, and the turn ends. If no replacement watcher started, nothing can wake the session again until the user types.

This happened twice in one night on a long GPU replay: the log ended with a normal `stop`, no error, and the session sat idle for 6 h 39 m and 24 m.

## What it does

When a turn starts from a subagent completion notice, the guard checks the pi-subagents async status before the turn settles. If no run is queued or running, it adds one message and asks Pi for one more model request:

> watch-guard: this turn started from a subagent completion notice, and no subagent is running now. If a watch target is still unfinished, start one watcher in this turn with a stop condition and a budget. If the target is finished, name the line that proves it and end the turn. Do not start a watcher with no target.

The check is mechanical. It reads the run list over the in-process event bus (`subagents:rpc:v1:request`, method `status`), so it does not depend on the model remembering to look.

## Install

```bash
pi install git:github.com/lan-avelino/pi-watch-guard
```

Then run `/reload`, or start a new session.

## Use

```
/watch-guard on      enable for this session
/watch-guard off     disable
/watch-guard status  show state, last check, live run count, last error
```

Off by default. With it on, every subagent completion that ends a turn forces one extra turn, including ordinary reviewer and worker completions. Turn it on when you start a watch phase, not for general work.

## Limits

- One continuation per completion notice. If the model still ends without a watcher, the guard stays quiet until the next notice. This keeps it loop-free.
- It does nothing when the turn was aborted, or when user input is already queued.
- It needs pi-subagents. If no status reply arrives within 2 s, it does not fire and records the error in `/watch-guard status`.
- It does not start watchers. It asks the model to, with the target and the stop condition named.

## Test

```bash
node --test
```
