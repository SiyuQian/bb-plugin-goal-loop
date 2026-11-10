Prepare a goal before a long task starts, then keep its agent working across
rounds without prompting it each time.

## What you get

- A workflow checks each new task before normal dispatch, including later tasks
  in the same thread. Assessment is read-only; a new thread without a ready
  environment uses a bootstrap controller. It does not implement the task.
- Work estimated or suspected to take at least 15 minutes, or whose estimate is
  uncertain, needs a goal. Short questions and clear small changes can proceed
  without one. Asking for a plan still authorizes only a plan.
- The server validates the assessment against the original request and prepares
  the goal before release. The workflow's reply cannot bypass that check.
- A `Goal preparing` card shows preparation at round 1. It offers cancellation,
  with no Resume action that could skip preparation.
- Codex and Claude share the plugin round loop and `goal_loop_update` tool.
  Completion needs evidence; a blocker needs 3 consecutive reports. Each
  completed turn starts another round, up to 256 by default (`maxRounds`).
- Active goals have Pause, paused or blocked goals have Resume, and the close
  button clears the goal. Pressing Stop pauses it. CLI commands include
  `bb goal status`, `preflight-status`, `pause`, `resume`, and `clear`.

## Scope

This gate uses the public BB SDK. Normal dispatch waits for preflight, but
explicit Send now, editing and resending a message, and compaction do not pass
through the dispatch hook. These paths are outside the gate.

Child threads and plugin-created threads such as workflow workers and side chats
are excluded. Native Codex goals remain separate provider state; an active
native goal is not silently replaced by a plugin goal. State lives in this
plugin's storage on the BB server.
