---
name: goal
description: "Inspect, pause, resume, or clear a thread's durable goal with `bb goal`. Use when the user asks about the goal loop, its round count, or why it stopped."
---

# Goal

A goal keeps a thread working across many rounds. The agent starts one with
`create_goal`. Each time a turn completes, BB starts the next round. The
loop ends when one of these happens:

| Status | Cause |
|---|---|
| `complete` | The agent called `update_goal` with status `complete` and evidence. |
| `blocked` | The agent reported the same `blocker_key` in 3 consecutive rounds. |
| `budgetLimited` | The goal used all its rounds (default 256, plugin setting `maxRounds`). |
| `paused` | A turn did not complete (the user pressed Stop, or a restart), or someone ran `bb goal pause`. |

A user message does not resume a paused goal. Only `bb goal resume`, or the
Resume button on the goal card above the composer, does. The card also has
Pause and a close button that clears the goal.

## Commands

Each command acts on the current thread. Pass `--thread <id>` to act on
another thread.

```sh
bb goal status [--json]           # objective, status, round, open blocker
bb goal pause                     # the current turn finishes, then no new round starts
bb goal resume [--max-rounds <n>] # active again; starts the next round now if the thread is idle
bb goal clear                     # delete the goal
```

`bb goal resume` needs `--max-rounds` with a value greater than the current
round when the goal used all its rounds. A complete goal cannot resume. Ask
the agent to create a new goal instead.

Run `bb goal resume` only when the user asks for it. Do not resume, pause,
or clear a goal to escape the round loop.
