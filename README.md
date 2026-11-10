# bb-plugin-goal-loop

[中文说明](README.zh-CN.md)

A [bb](https://getbb.app) plugin that checks each new task before normal
dispatch, prepares a goal for work that may take 15 minutes or longer, and
keeps the agent working across rounds until it finishes or meets a stop condition.

## Install

```sh
bb plugin install https://github.com/SiyuQian/bb-plugin-goal-loop
# or follow a release range:
bb plugin install git:https://github.com/SiyuQian/bb-plugin-goal-loop.git@^0.1.0
bb plugin enable workflows
```

Requires bb 0.49 or later and the built-in Workflows plugin. New sessions
receive the agent tools; an existing session receives tool changes when it restarts.

## Before work starts

1. The plugin checks **each new task**, including later tasks in an existing
   thread. It holds normal dispatch while a workflow assesses the original request.
2. The assessment is read-only. It estimates total work, including investigation
   and verification. An upper estimate of at least 15 minutes, a suspected long
   task, or uncertainty requires a goal. Fitting work into one model turn does
   not exempt it. Short questions, clarification, and clearly small changes can
   proceed without a goal.
3. A worker submits the assessment through the plugin's internal CLI. The server
   checks it against the stored original request and prepares any required goal
   before releasing that request. Workflow output alone cannot release it.
4. A prepared goal has status `prepared` and starts at round 1. It becomes
   `active` when the original task starts. Its objective preserves the user's
   scope: asking for a plan or design does not authorize implementation.

When a new thread's environment is not ready, a bootstrap controller thread
runs the preflight workflow. Its assessment workers do not implement the original
task. If preparation fails, the original request stays held; inspect it with
`bb goal preflight-status --thread <id>`. After fixing the reported issue,
use `bb goal preflight-retry --thread <id>` to assess the held task again.

### Dispatch boundary

This uses the public BB SDK. Normal dispatch is held until preflight succeeds.
The SDK's explicit **Send now** path bypasses dispatch middleware; editing and
resending a message, and compaction, also do not pass through this hook. Those
paths are outside this gate. The plugin does not claim to intercept every
possible way of starting a turn.

## Goal rounds

- After each completed turn, the plugin starts the next round, up to 256 rounds
  by default (`maxRounds`). The agent cannot change this limit.
- The agent calls `goal_loop_update` with status `complete` only after the
  entire objective is done and verified. Completion requires `evidence`.
- Status `blocked` requires the same `blocker_key` in 3 consecutive rounds.
  Until then the goal remains active. A round without that report resets the count.
- A turn interrupted by Stop or a restart pauses the goal. An ordinary user
  message does not resume it. Use the card's Resume button or `bb goal resume`.

| Status | Meaning |
|---|---|
| `prepared` | Goal preparation precedes the original task; round 1 has not started. |
| `active` | A new round starts after each completed turn. |
| `complete` | The agent reported verified completion with evidence. |
| `blocked` | The same blocker was reported in 3 consecutive rounds. |
| `budgetLimited` | The goal used all its rounds. |
| `paused` | A turn was interrupted, or someone paused the goal. |

The user sees `Goal round N/M` for each continuation. The objective and round
instructions are sent to the agent.

## Goal card

A card above the thread's composer shows every goal except a completed one.
Expand it to see the original objective, blocker, and status note.

- `Goal preparing · round 1/256`: only the close button is available. It cancels
  preparation and keeps the original request from being released. There is no
  Resume button that could bypass preparation.
- Active goals have **Pause**; paused and blocked goals have **Resume**.
- A goal that used all its rounds needs `bb goal resume --max-rounds <n>`.
- The close button clears the goal. A new user task can start a new preflight.

## Commands

Commands default to the current thread. Add `--thread <id>` to inspect or manage
another thread.

```sh
bb goal status [--json]
bb goal preflight-status --thread <id>  # preflight state and any error
bb goal preflight-retry --thread <id>   # retry a failed or cancelled assessment
bb goal pause
bb goal resume [--max-rounds <n>]
bb goal clear
```

A prepared goal cannot be resumed. To resume a goal that used all its rounds,
the new limit must exceed its current round. A completed goal cannot resume.
`preflight-complete` is an internal workflow callback, invoked as
`bb plugin run goal-loop preflight-complete ...`; it is not a manual bypass.

## Providers and scope

Codex and Claude use the same plugin preflight and round loop. Both receive
`goal_loop_update`, whose name avoids a collision with native Codex goal tools.
Claude also retains the legacy `create_goal` and `update_goal` tools. The plugin
does not expose those names to Codex.

Native Codex goals have separate provider state. An active native goal is not
silently replaced with a second plugin goal; preparation reports a conflict.
`bb goal status` reports this plugin's goal, not the provider's native goal.

Child threads and threads created by a plugin, including workflow workers and
side chats, are excluded from task preflight and the goal tools. Their callers
consume their result when they stop, so adding rounds would change that contract.

## Settings and development

```sh
bb plugin config goal-loop set maxRounds 256  # applies to goals created later
npm install
npm test
npm run typecheck
bb plugin build
bb plugin install .
```

- `server.ts`: dispatch gate, tools, round loop, CLI, and card RPC.
- `workflow.ts`: read-only assessment and server submission workflow.
- `app.tsx`: composer card.
- `contract.ts`: shared goal schema and RPC contract.

Goal state lives in plugin key-value storage (`goal:<threadId>`). Goals prepared
for a task include its `taskId`; the field remains optional for older stored
goals. On reload the plugin checks active goals on idle threads for missed rounds.

## License

[MIT](LICENSE)
