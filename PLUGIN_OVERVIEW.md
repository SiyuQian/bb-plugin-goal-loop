Keep an agent working on a long-running objective without prompting it
every turn.

## What you get

- Two agent tools. `create_goal` starts a goal when the user asks for
  long-running work, even if the user does not say "goal". `update_goal`
  ends it.
- Automatic rounds: each time a turn completes, BB starts the next round,
  up to 256 rounds by default (setting `maxRounds`).
- Strict exits: "complete" needs evidence of verified work. "blocked" is
  accepted only after the same blocker is reported in 3 consecutive rounds.
- A card above the composer shows the thread's goal: its status, round, and
  objective. Pause and Resume buttons control the round loop, and the close
  button clears the goal.
- Pressing Stop pauses the goal. `bb goal status`, `pause`, `resume`, and
  `clear` manage it from a terminal.

## Scope

Codex threads keep Codex's native goals. Child threads and threads that a
plugin spawned (workflow workers, side chats) do not get the tools, because
their caller reads each stop as the result. State lives in this
plugin's storage on the BB server.
