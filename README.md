# bb-plugin-goal-loop

[中文说明](README.zh-CN.md)

A [bb](https://getbb.app) plugin that keeps an agent working on a long task
across rounds, until the task is done or meets a stop condition.

## Install

```sh
bb plugin install https://github.com/SiyuQian/bb-plugin-goal-loop
# or follow a release range:
bb plugin install git:https://github.com/SiyuQian/bb-plugin-goal-loop.git@^0.2.0
```

Requires bb 0.49 or later. New sessions receive the agent tools. An existing
session receives tool changes when it restarts.

## Starting a goal

The plugin never holds a message. A goal starts in one of two ways:

1. **Send as goal.** Open the menu next to the composer's send button and pick
   **Send as goal**. The message is sent as usual, and its text becomes the
   goal's objective. This works in an existing thread and on the New thread
   screen. If the thread already has an unfinished goal, bb refuses the
   message and keeps the draft.
2. **The agent starts it.** The agent calls `goal_loop_create` when it is about
   to stop while requested work remains, and the next step does not need a
   decision from the user. It writes the objective from the conversation. It
   does not start a goal for a question, a plan or design discussion, or a
   choice the user must make. Turn this off with the `autoGoal` setting.

## Goal rounds

- After each completed turn, the plugin starts the next round, up to 256 rounds
  by default (`maxRounds`). The agent cannot change this limit.
- The agent calls `goal_loop_update` with status `complete` only after the
  entire objective is done and verified. Completion requires `evidence`.
- Status `blocked` requires the same `blocker_key` in 3 consecutive rounds.
  Until then the goal remains active. A round without that report resets the count.
- A user message to a thread with a blocked goal makes the goal active again.
  The next round starts after that message's turn ends.
- A turn interrupted by Stop or a restart pauses the goal. A user message does
  not resume a paused goal. Use the card's Resume button or `bb goal resume`.
- A user message sent while a goal is active is delivered as usual. The next
  round starts after its turn ends.

| Status | Meaning |
|---|---|
| `active` | A new round starts after each completed turn. |
| `complete` | The agent reported verified completion with evidence. |
| `blocked` | The same blocker was reported in 3 consecutive rounds. |
| `budgetLimited` | The goal used all its rounds. |
| `paused` | A turn was interrupted, or someone paused the goal. |

The user sees `Goal round N/M` for each continuation. The objective and round
instructions are sent to the agent.

## Goal card

A card above the thread's composer shows every goal except a completed one.
Expand it to see the objective, blocker, and status note.

- Active goals have **Pause**. Paused and blocked goals have **Resume**.
- A goal that used all its rounds needs `bb goal resume --max-rounds <n>`.
- The close button clears the goal.

## Commands

Commands default to the current thread. Add `--thread <id>` to inspect or manage
another thread.

```sh
bb goal status [--json]
bb goal pause
bb goal resume [--max-rounds <n>]
bb goal clear
```

To resume a goal that used all its rounds, the new limit must exceed its
current round. A completed goal cannot resume.

## Providers and scope

Codex and Claude receive the same tools: `goal_loop_create` and
`goal_loop_update`. These names avoid a collision with native Codex goal tools.
Sessions that started before 0.2.0 can still call the old names `create_goal`
and `update_goal`.

Native Codex goals have separate provider state. While a native Codex goal is
active, the plugin refuses to start a second goal. `bb goal status` reports
this plugin's goal, not the provider's native goal.

Child threads and threads created by a plugin, including workflow workers and
side chats, receive no goal tools. Their callers consume their result when they
stop, so adding rounds would change that contract.

## Upgrading from 0.1.x

0.1.1 held each task behind a preflight workflow. On its first start, 0.2.0
archives the hidden preflight controller threads, deletes the preflight records,
and releases the tasks that the preflight still held. It deletes each
`prepared` goal, because its task never started under it. If a prepared goal
replaced an active goal, 0.2.0 restores that active goal. The `preflight-status` and `preflight-retry` commands are removed,
and the plugin no longer needs the Workflows plugin.

## Settings and development

```sh
bb plugin config goal-loop set maxRounds 256  # applies to goals created later
bb plugin config goal-loop set autoGoal false # only Send as goal starts a goal
npm install
npm test
npm run typecheck
bb plugin build
bb plugin install .
```

- `server.ts`: tools, round loop, Send as goal and blocked-goal dispatch hook,
  CLI, and card RPC.
- `app.tsx`: composer card and the Send as goal menu row.
- `contract.ts`: shared goal schema and RPC contract.

Goal state lives in plugin key-value storage (`goal:<threadId>`). On reload the
plugin checks active goals on idle threads for missed rounds.

## License

[MIT](LICENSE)
