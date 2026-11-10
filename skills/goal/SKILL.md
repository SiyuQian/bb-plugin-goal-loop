---
name: goal
description: "Inspect and manage a thread's Goal Loop goal with bb goal. Use for a goal's round count, a blocked or paused goal, or how a goal starts."
---

# Goal

A goal keeps the agent working across rounds. No message is held before work
starts. A goal starts in one of two ways:

- The user picks **Send as goal** in the menu next to the composer's send
  button. The message text becomes the objective.
- The agent calls `goal_loop_create` before it ends a turn while requested work
  remains, unless the next step needs a decision from the user. Do not start a
  goal for a question, a plan or design discussion, or a choice the user must
  make. Keep the objective within the user's scope: a request for a plan does
  not include its implementation.

## Goal state and tools

Codex and Claude use the same tools: `goal_loop_create` and `goal_loop_update`.
Use `goal_loop_update` to mark the goal `complete` with evidence or to report a
blocker. Native Codex goals are separate provider state. Do not start a plugin
goal while a native goal is active.

| Status | Cause or action |
|---|---|
| `active` | A completed turn starts the next round. |
| `complete` | The entire objective is done and verified, with evidence. |
| `blocked` | The same `blocker_key` was reported in 3 consecutive rounds. A user message makes it active again. |
| `budgetLimited` | All rounds were used (default 256, setting `maxRounds`). |
| `paused` | A turn was interrupted, or someone paused the goal. Only Resume restarts it. |

## Commands

Commands default to the current thread. Add `--thread <id>` for another one.

```sh
bb goal status [--json]           # this plugin's goal, not a native provider goal
bb goal pause
bb goal resume [--max-rounds <n>]
bb goal clear
```

To resume a round-limited goal, `--max-rounds` must exceed the current round.
A complete goal cannot resume. Run resume only when the user asks. Do not
pause, clear, or resume a goal to escape the round loop.
