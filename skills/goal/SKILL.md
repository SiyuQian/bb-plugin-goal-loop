---
name: goal
description: "Inspect task preflight and manage a thread's plugin goal with bb goal. Use for a held request, goal preparation, round count, or a goal that stopped."
---

# Goal

Each new task passes through a preflight workflow before normal dispatch,
including later tasks in an existing thread. Assessment is read-only. Work
estimated or suspected to need at least 15 minutes, or with uncertain scope,
requires a goal. Finishing within one model turn is not an exemption.

The server checks the worker's assessment against the stored original request
and prepares the goal before it releases the request. The workflow's response
alone cannot authorize release. Preserve the user's scope: a plan or design
request does not authorize implementation. When a new thread's environment
is not ready, a bootstrap controller runs this workflow; assessment workers
do not perform the original task.

The gate uses the public SDK's normal dispatch hook. Explicit Send now,
editing and resending a message, and compaction do not pass through that hook.
Do not claim the gate covers those paths.

## Goal state and tools

Codex and Claude use the same plugin round loop. Use `goal_loop_update` to
mark this plugin's goal `complete` with evidence or report a blocker. Claude
retains legacy `create_goal` and `update_goal`; the plugin does not expose
those names to Codex. Native Codex goals are separate provider state, and an
active native goal must not be silently replaced with a second plugin goal.

| Status | Cause or action |
|---|---|
| `prepared` | Waiting for the original task to start, at round 1. Only clear/cancel is available; do not Resume. |
| `active` | A completed turn starts the next round. |
| `complete` | The entire objective is done and verified, with evidence. |
| `blocked` | The same `blocker_key` was reported in 3 consecutive rounds. |
| `budgetLimited` | All rounds were used (default 256, setting `maxRounds`). |
| `paused` | A turn was interrupted, or someone paused the goal. |

A user message does not resume a paused goal. Only `bb goal resume` or the
card's Resume button does. Clearing a prepared goal cancels preparation and
keeps that original request from being released. A new user task can start
a new preflight.

## Commands

Commands default to the current thread. Add `--thread <id>` for another one.

```sh
bb goal status [--json]                 # this plugin's goal, not a native provider goal
bb goal preflight-status --thread <id> # held request, state, and any preparation error
bb goal preflight-retry --thread <id>  # retry a failed or cancelled assessment
bb goal pause
bb goal resume [--max-rounds <n>]
bb goal clear
```

`preflight-complete` is an internal workflow callback, invoked through
`bb plugin run goal-loop preflight-complete ...`. Do not invoke it manually
to bypass a held request or claim that a workflow reply released the task.

To resume a round-limited goal, `--max-rounds` must exceed the current round.
Prepared and complete goals cannot resume. Run resume only when the user
asks. Do not pause, clear, or resume a goal to escape the round loop.
