# bb-plugin-goal-loop

[English](README.md)

一个 [bb](https://getbb.app) 插件：让 agent 跨多轮持续处理一个长任务，直到完成或达到停止条件。

## 安装

```sh
bb plugin install https://github.com/SiyuQian/bb-plugin-goal-loop
# 或跟随版本范围：
bb plugin install git:https://github.com/SiyuQian/bb-plugin-goal-loop.git@^0.2.0
```

需要 bb 0.49 及以上。新会话会拿到工具；已有会话要等重建后才收到工具变更。

## 如何开启 goal

插件不会扣住任何消息。goal 有两种开启方式：

1. **作为 goal 发送。** 打开输入框发送按钮旁边的菜单，选 **Send as goal**。消息照常发出，消息原文就是 goal 的目标。已有 thread 和新建 thread 页面都可以用。如果这个 thread 已经有未完成的 goal，bb 会拒绝这条消息并保留草稿。
2. **agent 自己开启。** agent 准备结束本轮、但用户要求的工作还没做完，并且下一步不需要用户做决定时，会调用 `goal_loop_create`。目标由 agent 根据对话来写。提问、计划或设计讨论、需要用户选择的事情，不会开 goal。可以用 `autoGoal` 设置关掉这种方式。

## 自动续跑

- 每轮正常完成后，插件自动开始下一轮。默认最多 256 轮，设置项是 `maxRounds`，agent 不能自己改上限。
- 整个目标做完并验证后，agent 才能用 `goal_loop_update` 标记 `complete`，且必须提供证据 `evidence`。
- 标记 `blocked` 需要同一个 `blocker_key` 连续 3 轮上报。不足 3 轮时仍为 `active`；中间有一轮没有上报，计数清零。
- goal 是 `blocked` 时，用户发一条消息会让它恢复为 `active`。这条消息的回合结束后开始下一轮。
- 用户按 Stop 或重启打断回合时，goal 暂停。用户消息不会恢复已暂停的 goal，需要卡片上的 Resume 或 `bb goal resume`。
- goal 进行中时，用户发的消息照常送达。它的回合结束后再开始下一轮。

| 状态 | 含义 |
|---|---|
| `active` | 进行中，每轮完成后自动开始下一轮 |
| `complete` | agent 提供证据，标记验证完成 |
| `blocked` | 同一障碍连续 3 轮上报 |
| `budgetLimited` | 轮数用完 |
| `paused` | 回合被打断，或有人暂停了 goal |

每次续跑时，用户看到一行 `Goal round N/M`，目标原文和续跑规则发给 agent。

## 输入框上方的卡片

有 goal 且尚未完成时，卡片显示状态和轮次。展开可查看目标、障碍和状态说明。

- `active` 显示 **Pause**；`paused` 和 `blocked` 显示 **Resume**。
- `budgetLimited` 要通过 `bb goal resume --max-rounds <n>` 提高轮数上限后恢复。
- 关闭按钮清除 goal。

## 命令

默认作用于当前 thread，加 `--thread <id>` 可指定其他 thread。

```sh
bb goal status [--json]
bb goal pause
bb goal resume [--max-rounds <n>]
bb goal clear
```

轮数用完后，新上限必须大于当前轮次；`complete` 不能恢复。

## Provider 与范围

Codex 和 Claude 拿到同样的工具：`goal_loop_create` 和 `goal_loop_update`，名字避开了 Codex 原生 goal 工具。0.2.0 之前启动的会话仍可调用旧名字 `create_goal`、`update_goal`。

Codex 原生 goal 保存在 provider 自己的状态里。已有原生 active goal 时，插件拒绝再开第二个 goal。`bb goal status` 查看的是插件 goal，不是 Codex 原生 goal。

子线程，以及 workflow worker、side chat 等插件创建的 thread，不提供 goal 工具。调用方会在它们停止时消费结果，额外续跑会改变这个约定。

## 从 0.1.x 升级

0.1.1 会把每个任务扣在前置 workflow 后面。0.2.0 第一次启动时会归档隐藏的 preflight controller thread，删除 preflight 记录，并放行仍被扣住的任务。`prepared` 的 goal 从未真正开始，会被删除；如果它当初替换了一个 active goal，就恢复那个 goal。`preflight-status`、`preflight-retry` 命令已移除，插件也不再依赖 Workflows 插件。

## 设置与开发

```sh
bb plugin config goal-loop set maxRounds 256  # 对之后创建的 goal 生效
bb plugin config goal-loop set autoGoal false # 只有 Send as goal 能开启 goal
npm install
npm test
npm run typecheck
bb plugin build
bb plugin install .
```

- `server.ts`：工具、续跑、处理 Send as goal 和 blocked goal 的 dispatch hook、CLI 和卡片 RPC。
- `app.tsx`：输入框上方的卡片和 Send as goal 菜单项。
- `contract.ts`：共用的 goal schema 和 RPC 定义。

goal 按 thread 存在插件 kv（`goal:<threadId>`）。插件重载后会检查空闲 thread 中仍为 active 的 goal，补上错过的续跑。

## 许可证

[MIT](LICENSE)
