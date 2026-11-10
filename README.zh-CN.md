# bb-plugin-goal-loop

[English](README.md)

一个 [bb](https://getbb.app) 插件：让 agent 在一个线程里持续推进长期目标（goal），不用人每轮去催。

## 安装

```sh
bb plugin install https://github.com/SiyuQian/bb-plugin-goal-loop
# 或者跟随某个版本范围：
bb plugin install git:https://github.com/SiyuQian/bb-plugin-goal-loop.git@^0.1.0
```

需要 bb 0.49 及以上。新开的线程会拿到工具；已经在运行的会话要等重建之后才有。

## 行为

1. 用户的请求是长期目标时（迁移、大范围重构、"一直修到测试全过"、多步骤的构建或调研），agent 先调用 `create_goal`。用户没说 "goal" 也一样。
2. 之后 agent 每停一次（回合正常结束），插件自动发下一轮消息。默认最多 256 轮，设置项 `maxRounds` 可以改默认值。agent 不能自己改上限。
3. 只有整个目标做完并验证过，agent 才能用 `update_goal` 标记 `complete`，而且必须附上证据（`evidence`）。
4. 标记 `blocked` 需要同一个障碍（同一个 `blocker_key`）连续 3 轮上报。不足 3 轮时 goal 仍是 `active`，下一轮照常开始。中间有一轮没上报，计数清零。
5. 回合没有正常结束时（用户按了 Stop，或宿主重启打断回合），goal 暂停。之后用户发普通消息也不会恢复它，只能用卡片上的 Resume 或 `bb goal resume` 恢复。

| 状态 | 含义 |
|---|---|
| `active` | 进行中，每轮结束后自动开始下一轮 |
| `complete` | agent 带证据标记完成 |
| `blocked` | 同一障碍连续 3 轮上报 |
| `budgetLimited` | 轮数用完 |
| `paused` | 回合被打断，或有人暂停了 goal |

续跑消息分两部分：用户能看到一行 `Goal round N/M`，目标原文和规则只发给 agent。

## 输入框上方的卡片

线程有 goal（`complete` 除外）时，输入框上方会出现一张卡片，标题是状态和轮次，例如 `Goal · round 3/256`、`Goal paused · round 3/256`。展开后可以看到目标原文、还没解除的障碍，以及暂停或停止的原因，下面还有一个按钮：

- `active` 显示 **Pause**：当前回合照常结束，之后不再开始新一轮。
- `paused` 和 `blocked` 显示 **Resume**：线程空闲时马上开始下一轮，否则等当前回合结束后再开始。
- `budgetLimited` 没有按钮，因为恢复时要给新的轮数上限。卡片上的说明会写出对应的 `bb goal resume --max-rounds <n>` 命令。

右上角的 × 用来清除 goal。goal 有任何变化，卡片都会自动刷新。

## 命令

默认作用于当前线程，加 `--thread <id>` 可以指定其他线程。

```sh
bb goal status [--json]           # 目标、状态、轮次、未解决的障碍
bb goal pause                     # 当前回合照常结束，之后不再开始新一轮
bb goal resume [--max-rounds <n>] # 重新激活；线程空闲时立即开始下一轮
bb goal clear                     # 删除 goal
```

轮数用完后恢复，需要传 `--max-rounds`，值要大于当前轮次。`complete` 的 goal 不能恢复，要让 agent 新建一个。

## 设置

```sh
bb plugin config goal-loop set maxRounds 256
```

新上限只对之后创建的 goal 生效。

## 范围

- Codex 线程不提供这两个工具。Codex 有原生 goal，BB 已经支持。
- 子线程（有父线程）和插件创建的线程（workflow worker、side chat）也不提供。调用方会把它们每次停下的输出当成结果，自动续跑会让调用方拿到半成品。

## 开发

```sh
npm install
npm test            # node --test，用 @get-bb/plugin-sdk/testing 的 fake host（Node 22.18 及以上）
npm run typecheck
bb plugin build
bb plugin install .
```

- `server.ts`：工具、续跑循环、CLI，以及卡片用的 RPC。
- `app.tsx`：输入框上方的卡片。
- `contract.ts`：前后端共用的 goal schema 和 RPC 定义。

状态按线程存在插件自己的 kv 里（`goal:<threadId>`）。插件重载后，会检查空闲线程里还在 `active` 的 goal，补上错过的那次续跑。

## 许可证

[MIT](LICENSE)
