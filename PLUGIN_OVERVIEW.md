Keep an agent working on a long task across rounds, without prompting it each
time.

## What you get

- No message is held. Pick **Send as goal** in the send button's menu to send a
  message and start a goal with its text as the objective.
- The agent starts a goal with `goal_loop_create` when it would otherwise stop
  with requested work left. It does not start one for a question, a plan or
  design discussion, or a choice the user must make. The `autoGoal` setting
  turns this off.
- Codex and Claude share the plugin round loop and the `goal_loop_create` and
  `goal_loop_update` tools. Completion needs evidence. A blocker needs 3
  consecutive reports. Each completed turn starts another round, up to 256 by
  default (`maxRounds`).
- A user reply makes a blocked goal active again. Pressing Stop pauses the goal,
  and only Resume restarts a paused goal.
- The composer card has Pause, Resume, and a close button that clears the goal.
  CLI commands include `bb goal status`, `pause`, `resume`, and `clear`.

## Scope

Child threads and plugin-created threads such as workflow workers and side chats
are excluded. Native Codex goals remain separate provider state. While a native
goal is active, the plugin refuses to start a second goal. State lives in this
plugin's storage on the BB server.
