# bb-plugin-goal-loop

[中文说明](README.zh-CN.md)

A [bb](https://getbb.app) plugin that keeps an agent working on a long-running
goal. Each time the agent stops, bb starts the next round, until the goal is
complete, blocked, or out of rounds.

## Install

```sh
bb plugin install https://github.com/SiyuQian/bb-plugin-goal-loop
# or follow a release range:
bb plugin install git:https://github.com/SiyuQian/bb-plugin-goal-loop.git@^0.1.0
```

Requires bb 0.49 or later. New threads get the tools. A session that is
already running gets them when it restarts.

## How it works

1. When the user asks for a long-running objective (a migration, a large
   refactor, "keep going until all tests pass", a multi-step build or
   research task), the agent calls `create_goal` first, even if the user does
   not say "goal".
2. Each time a turn completes, the plugin starts the next round. A goal runs
   at most 256 rounds by default (setting `maxRounds`). The agent cannot
   change the limit.
3. The agent marks the goal `complete` with `update_goal` only when the whole
   objective is done and verified. The call needs `evidence`.
4. The agent can mark the goal `blocked` only when it reports the same
   `blocker_key` in 3 consecutive rounds. Before that, the goal stays
   `active` and the next round starts. A round without the report resets the
   count.
5. A turn that does not complete (the user pressed Stop, or a restart
   interrupted it) pauses the goal. A new user message does not resume it.
   Use the card's Resume button or `bb goal resume`.

| Status | Meaning |
|---|---|
| `active` | Running. A new round starts after each completed turn. |
| `complete` | The agent marked it done, with evidence. |
| `blocked` | The same blocker was reported in 3 consecutive rounds. |
| `budgetLimited` | The goal used all its rounds. |
| `paused` | A turn was interrupted, or someone paused the goal. |

Each round message has two parts. The user sees one line, `Goal round N/M`.
The objective and the rules go to the agent only.

## Goal card

While a thread has a goal that is not complete, a card above the composer
shows its status and round, for example `Goal · round 3/256` or
`Goal paused · round 3/256`. Expand it to see the objective, an open blocker,
and the reason the goal stopped. The card has one button:

- **Pause** (active goal): the current turn finishes, then no new round
  starts.
- **Resume** (paused or blocked goal): the next round starts now if the
  thread is idle, or when the current turn ends.
- No button when the goal used all its rounds. Resuming it needs a new
  limit, so the card shows the `bb goal resume --max-rounds <n>` command.

The × button clears the goal. The card refreshes by itself when the goal
changes.

## Commands

Each command acts on the current thread. Pass `--thread <id>` to act on
another thread.

```sh
bb goal status [--json]           # objective, status, round, open blocker
bb goal pause                     # the current turn finishes, then no new round starts
bb goal resume [--max-rounds <n>] # active again; starts the next round now if the thread is idle
bb goal clear                     # delete the goal
```

To resume a goal that used all its rounds, pass `--max-rounds` with a value
greater than the current round. A complete goal cannot resume.

## Settings

```sh
bb plugin config goal-loop set maxRounds 256
```

The limit applies to goals created after the change.

## Scope

- Codex threads do not get the tools. Codex has its own goals, which bb
  supports.
- Child threads and threads that a plugin spawned (workflow workers, side
  chats) do not get the tools. Their caller reads each stop as the result, so
  extra rounds would give it partial work.

## Development

```sh
npm install
npm test            # node --test with the @get-bb/plugin-sdk/testing fake host (Node 22.18 or later)
npm run typecheck
bb plugin build
bb plugin install .
```

- `server.ts`: the tools, the round loop, the CLI, and the RPC for the card.
- `app.tsx`: the card above the composer.
- `contract.ts`: the goal schema and the RPC contract that both sides share.

Goal state lives in the plugin's key-value storage, one entry per thread
(`goal:<threadId>`). After a reload, the plugin checks the active goals on
idle threads and starts a round it missed.

## License

[MIT](LICENSE)
