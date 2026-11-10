# bb-plugin-goal-loop

[English](README.md)

一个 [bb](https://getbb.app) 插件：每个新任务在正常发送前先评估；预计或可能需要至少 15 分钟，就先准备 goal，再开始原任务。之后自动续跑，直到完成或达到停止条件。

## 安装

```sh
bb plugin install https://github.com/SiyuQian/bb-plugin-goal-loop
# 或跟随版本范围：
bb plugin install git:https://github.com/SiyuQian/bb-plugin-goal-loop.git@^0.1.0
bb plugin enable workflows
```

需要 bb 0.49 及以上，以及内置 Workflows 插件。新会话会拿到工具；已有会话要等重建后才收到工具变更。

## 先评估，再开工

1. 检查对象是**每个新任务**，包括同一个 thread 后来收到的任务，不是只检查 thread 的第一条消息。正常 dispatch 会先暂停，等待 workflow 评估原始请求。
2. 评估只读，不执行原任务。时间估计包括调查和验证。估计上限达到 15 分钟、疑似长任务，或者无法确定时，都需要 goal。不能因为“一个模型回合能做完”就跳过。简短问答、澄清和明确的小改动可以不建 goal。
3. workflow worker 通过内部 CLI 提交判定。服务端核对已保存的原始请求，先准备所需的 goal，验证后才放行原任务。workflow 回复“成功”本身不能放行。
4. 准备中的 goal 状态是 `prepared`，轮次为 1。原任务启动后才变成 `active`。目标保持用户原本的范围：要求计划或设计，就只做计划或设计，不擅自进入实现。

全新 thread 的环境尚未准备好时，由 bootstrap controller thread 运行前置 workflow。评估 worker 不会实施原任务。准备失败时，原请求继续保持等待，可用 `bb goal preflight-status --thread <id>` 查看状态和错误。修复错误后，用 `bb goal preflight-retry --thread <id>` 重新评估等待中的任务。

### dispatch 的覆盖边界

插件只使用公开 BB SDK。正常 dispatch 必须等前置检查通过。但 SDK 中用户显式选择 **Send now** 的路径会绕过 dispatch middleware；编辑后重发消息、compaction 也不经过这个 hook。这些入口不在拦截范围内，插件不能保证覆盖所有启动回合的方式。

## 自动续跑

- 每轮正常完成后，插件自动开始下一轮。默认最多 256 轮，设置项是 `maxRounds`，agent 不能自己改上限。
- 整个目标做完并验证后，agent 才能用 `goal_loop_update` 标记 `complete`，且必须提供证据 `evidence`。
- 标记 `blocked` 需要同一个 `blocker_key` 连续 3 轮上报。不足 3 轮时仍为 `active`；中间有一轮没有上报，计数清零。
- 用户按 Stop 或重启打断回合时，goal 暂停。普通用户消息不会恢复它，需要卡片上的 Resume 或 `bb goal resume`。

| 状态 | 含义 |
|---|---|
| `prepared` | 正在准备 goal，原任务的第 1 轮尚未开始 |
| `active` | 进行中，每轮完成后自动开始下一轮 |
| `complete` | agent 提供证据，标记验证完成 |
| `blocked` | 同一障碍连续 3 轮上报 |
| `budgetLimited` | 轮数用完 |
| `paused` | 回合被打断，或有人暂停了 goal |

每次续跑时，用户看到一行 `Goal round N/M`，目标原文和续跑规则发给 agent。

## 输入框上方的卡片

有 goal 且尚未完成时，卡片显示状态和轮次。展开可查看原始目标、障碍和状态说明。

- `Goal preparing · round 1/256`：只有关闭按钮，用于取消准备；原请求不会被放行。没有可绕过检查的 Resume 按钮。
- `active` 显示 **Pause**；`paused` 和 `blocked` 显示 **Resume**。
- `budgetLimited` 要通过 `bb goal resume --max-rounds <n>` 提高轮数上限后恢复。
- 关闭按钮清除 goal。之后的新任务可以重新触发前置检查。

## 命令

默认作用于当前 thread，加 `--thread <id>` 可指定其他 thread。

```sh
bb goal status [--json]
bb goal preflight-status --thread <id>  # 前置状态及错误
bb goal preflight-retry --thread <id>   # 重试失败或取消的前置检查
bb goal pause
bb goal resume [--max-rounds <n>]
bb goal clear
```

`prepared` 不能 Resume；轮数用完后，新上限必须大于当前轮次；`complete` 不能恢复。
`preflight-complete` 是 workflow 内部回调，通过 `bb plugin run goal-loop preflight-complete ...` 调用，不是供用户手动跳过检查的命令。

## Provider 与范围

Codex 和 Claude 使用同一套插件前置检查和续跑机制，统一通过 `goal_loop_update` 更新插件 goal，避免与 Codex 原生工具重名。Claude 还保留旧的 `create_goal`、`update_goal`；插件不向 Codex 提供这两个同名工具。

Codex 原生 goal 保存在 provider 自己的状态里。已有原生 active goal 时，插件不会悄悄再建第二个 goal，准备过程会报告冲突。`bb goal status` 查看的是插件 goal，不是 Codex 原生 goal。

子线程，以及 workflow worker、side chat 等插件创建的 thread，不参与任务前置检查，也不提供 goal 工具。调用方会在它们停止时消费结果，额外续跑会改变这个约定。

## 设置与开发

```sh
bb plugin config goal-loop set maxRounds 256  # 对之后创建的 goal 生效
npm install
npm test
npm run typecheck
bb plugin build
bb plugin install .
```

- `server.ts`：dispatch 前置检查、工具、续跑、CLI 和卡片 RPC。
- `workflow.ts`：只读评估及向服务端提交结果。
- `app.tsx`：输入框上方的卡片。
- `contract.ts`：共用的 goal schema 和 RPC 定义。

goal 按 thread 存在插件 kv（`goal:<threadId>`）。为任务准备的 goal 带有 `taskId`；为兼容旧存储，这个字段可缺省。插件重载后会检查空闲 thread 中仍为 active 的 goal，补上错过的续跑。

## 许可证

[MIT](LICENSE)
