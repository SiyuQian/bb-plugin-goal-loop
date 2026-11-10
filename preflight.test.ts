import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeMessageDispatchHookContext, makeQueueEntry, makeThreadResponse, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import type { Preflight } from "./preflight.ts";
import type { WorkflowRunner } from "./preflight.ts";
import type { Goal } from "./contract.ts";

const TARGET = "thr_task";
const CONTROLLER = "thr_preflight";
const SETUP = "thr_setup";
const TASK = "实现完整的多 PR 管理，包括前后端、测试和验证。";

async function setup(task = TASK) {
  const launches: unknown[] = [];
  const stops: unknown[] = [];
  const sends: unknown[] = [];
  let nativeActive = false;
  let workflowState = "running";
  const controller = makeThreadResponse({ id: CONTROLLER, parentThreadId: TARGET, originPluginId: "goal-loop", status: "idle", environmentId: "env_ready" });
  const runner: WorkflowRunner = {
    start: async args => { launches.push(args); return { runId: "run_preflight" }; },
    status: async () => ({ id: "run_preflight", status: workflowState }) as never,
    stop: async args => { stops.push(args); return { runId: args.runId, stopped: true }; },
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "goal-loop", agentSkillIds: ["goal"],
    sdk: { threads: {
      get: async ({ threadId }) => threadId === CONTROLLER ? controller : threadId === SETUP
        ? makeThreadResponse({ id: SETUP, lifecycleOwnerThreadId: CONTROLLER, originPluginId: "workflows" })
        : makeThreadResponse({ id: TARGET, status: "pending" }),
      spawn: async () => controller,
      timeline: async () => ({ extensionStates: { "provider-codex/goal": nativeActive ? { status: "active" } : null } }) as never,
      getPluginMetadata: async () => ({ targetThreadId: TARGET }),
      events: { list: async () => [] },
      stop: async () => ({}), archive: async () => ({}),
      send: async args => { sends.push(args); return {} as never; },
    } },
  });
  plugin(bb, { runner });
  const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
  const row = makeQueueEntry({ id: "queued_task", threadId: TARGET, waitingOn: { kind: "plugin", pluginId: "goal-loop", reason: "preflight" } });
  const context = (queued = false) => makeMessageDispatchHookContext({
    thread: { id: TARGET }, initiator: "user", environment: null,
    requestedExecution: { providerId: "codex" },
    input: { text: task, blocks: [{ type: "text", text: task, mentions: [] }] },
    queuedMessages: queued ? [row] : [],
  });
  const cli = (argv: string[], caller = TARGET) => harness.behavior.runCli(argv, { threadId: caller });
  const record = () => bb.storage.kv.get<Preflight>(`preflight:${TARGET}`);
  const goal = () => bb.storage.kv.get<Goal>(`goal:${TARGET}`);
  async function submit(decision: Record<string, unknown> = {}) {
    const current = (await record())!;
    return cli(["preflight-complete", "--thread", TARGET, "--request", current.requestId, "--decision", JSON.stringify({
      upperEstimateMinutes: 2, needsGoal: false, objective: "A model must not expand the task", reason: "Estimated from the request", ...decision,
    })], SETUP);
  }
  async function queue() { await harness.behavior.emitThreadEvent("message.queued", { entry: row }); }
  return { bb, harness, hook, row, context, cli, record, goal, submit, queue, launches, stops, sends,
    setNative(value: boolean) { nativeActive = value; },
    setWorkflowState(value: string) { workflowState = value; },
  };
}

test("a real prepared goal is required before the held task is admitted", async () => {
  const t = await setup();
  assert.equal((await t.hook(t.context())).action, "wait");
  assert.equal(await t.goal(), undefined);
  await t.queue();
  assert.equal(t.launches.length, 1);
  assert.equal((await t.submit()).exitCode, 0);
  const prepared = (await t.goal())!;
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.objective, TASK);
  assert.equal(prepared.taskId, (await t.record())!.requestId);
  await t.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: TARGET }), lastAssistantText: null });
  assert.equal(t.sends.length, 0, "preparing must never start execution by the idle loop");
  assert.equal((await t.hook(t.context(true))).action, "proceed");
  assert.equal((await t.goal())!.status, "prepared");
  await t.harness.behavior.emitThreadEvent("message.dispatched", { entry: t.row });
  assert.equal((await t.goal())!.status, "active");
  const config = await t.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: TARGET }, provider: { id: "codex" } }));
  assert.match(config.instructions ?? "", /Goal Loop has already created/);
});

test("a registration-shaped success without a stored goal cannot release execution", async () => {
  const t = await setup();
  await t.hook(t.context()); await t.queue(); await t.submit();
  await t.bb.storage.kv.delete(`goal:${TARGET}`);
  assert.equal((await t.hook(t.context(true))).action, "wait");
  assert.notEqual((await t.record())!.state, "released");
});

test("repeated assessment registration is idempotent and preserves the original scope", async () => {
  const t = await setup();
  await t.hook(t.context()); await t.queue();
  await t.submit();
  const first = await t.goal();
  assert.equal((await t.submit()).exitCode, 0);
  assert.deepEqual(await t.goal(), first);
  assert.equal((await t.hook(t.context(true))).action, "proceed");
  assert.equal((await t.hook(t.context(true))).action, "proceed");
  assert.equal((await t.goal())!.round, 1);
});

test("a short assessed task proceeds without creating a goal", async () => {
  const t = await setup("把按钮颜色改成红色");
  await t.hook(t.context()); await t.queue();
  assert.equal((await t.submit()).exitCode, 0);
  assert.equal((await t.hook(t.context(true))).action, "proceed");
  assert.equal(await t.goal(), undefined);
});

test("a question does not create a workflow or a goal", async () => {
  const t = await setup("请问后台有哪些配置项？");
  assert.equal((await t.hook(t.context())).action, "proceed");
  assert.equal(await t.record(), undefined);
  assert.equal(t.launches.length, 0);
});

test("cancellation prevents late registration and does not release the task", async () => {
  const t = await setup();
  await t.hook(t.context()); await t.queue();
  await t.harness.behavior.emitThreadEvent("message.cancelled", { entry: t.row });
  assert.equal((await t.submit()).exitCode, 1);
  assert.equal(await t.goal(), undefined);
  assert.equal((await t.hook(t.context(true))).action, "wait");
  assert.equal(t.stops.length, 1);
});

test("clearing a prepared goal cancels the preflight instead of admitting work", async () => {
  const t = await setup();
  await t.hook(t.context()); await t.queue(); await t.submit();
  const cleared = await t.harness.behavior.callRpc("goal_clear", { threadId: TARGET });
  assert.deepEqual(cleared, { cleared: true });
  assert.equal(await t.goal(), undefined);
  assert.equal((await t.record())!.state, "cancelled");
  assert.equal((await t.hook(t.context(true))).action, "wait");
});

test("a native Codex goal is not given a second continuation controller", async () => {
  const t = await setup(); t.setNative(true);
  assert.equal((await t.hook(t.context())).action, "wait");
  assert.equal(await t.goal(), undefined);
  assert.equal(t.launches.length, 0);
});

test("another plugin's wait followed by cancellation cannot start a goal round", async () => {
  const t = await setup();
  await t.hook(t.context()); await t.queue(); await t.submit();
  assert.equal((await t.hook(t.context(true))).action, "proceed");
  assert.equal((await t.goal())!.status, "prepared");
  // Core has not dispatched: a later admission hook still holds the same row.
  await t.harness.behavior.emitThreadEvent("message.cancelled", { entry: t.row });
  await t.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: TARGET }), lastAssistantText: null });
  assert.equal(await t.goal(), undefined);
  assert.equal(t.sends.length, 0);
});

test("a new task expands an existing active goal only after another preflight", async () => {
  const t = await setup();
  await t.harness.behavior.callAgentTool("create_goal", { objective: "Finish the original feature" }, { threadId: TARGET });
  assert.equal((await t.hook(t.context())).action, "wait");
  assert.equal((await t.record())!.previousObjective, "Finish the original feature");
  await t.queue();
  assert.equal((await t.submit()).exitCode, 0);
  assert.equal((await t.goal())!.status, "prepared");
  assert.match((await t.goal())!.objective, /Finish the original feature/);
  assert.match((await t.goal())!.objective, /多 PR/);
  assert.equal((await t.goal())!.round, 1);
});

test("cancelling an expanded task restores the previous goal and its round budget", async () => {
  const t = await setup();
  await t.harness.behavior.callAgentTool("create_goal", { objective: "Finish the original feature" }, { threadId: TARGET });
  const original = { ...(await t.goal())!, round: 7, maxRounds: 20 };
  await t.bb.storage.kv.set(`goal:${TARGET}`, original);
  await t.hook(t.context()); await t.queue(); await t.submit();
  assert.equal((await t.goal())!.status, "prepared");
  assert.equal((await t.goal())!.round, 7);
  await t.harness.behavior.emitThreadEvent("message.cancelled", { entry: t.row });
  assert.deepEqual(await t.goal(), original);
});

test("a changed queue group can replace an admitted task still held by another plugin", async () => {
  const t = await setup();
  await t.hook(t.context()); await t.queue(); await t.submit();
  await t.hook(t.context(true));
  assert.equal((await t.record())!.state, "released");
  const oldRequest = (await t.record())!.requestId;
  const ctx = t.context(true);
  const task = TASK + "还要覆盖合并冲突。";
  assert.equal((await t.hook({ ...ctx, input: { text: task, blocks: [{ type: "text", text: task, mentions: [] }] } })).action, "wait");
  assert.notEqual((await t.record())!.requestId, oldRequest);
  assert.equal((await t.record())!.state, "pending");
});

test("a native goal conflict is also checked after switching the thread to Claude", async () => {
  const t = await setup(); t.setNative(true);
  const ctx = t.context();
  assert.equal((await t.hook({ ...ctx, requestedExecution: { ...ctx.requestedExecution, providerId: "claude-code" } })).action, "wait");
  assert.equal(await t.goal(), undefined);
});

test("a workflow ending without its registration leaves the task blocked", async () => {
  const t = await setup();
  await t.hook(t.context()); await t.queue();
  t.setWorkflowState("succeeded");
  await t.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: CONTROLLER, originPluginId: "goal-loop" }), lastAssistantText: "goalCreated: true" });
  assert.equal((await t.record())!.state, "failed");
  assert.equal((await t.hook(t.context(true))).action, "wait");
  assert.equal(await t.goal(), undefined);
});

test("workflow workers and child threads cannot recursively start preflight workflows", async () => {
  const t = await setup();
  const ctx = t.context();
  assert.equal((await t.hook({ ...ctx, parentThreadId: TARGET })).action, "proceed");
  assert.equal((await t.hook({ ...ctx, thread: { ...ctx.thread, originPluginId: "workflows" } })).action, "proceed");
  assert.equal((await t.hook({ ...ctx, initiator: "system" })).action, "proceed");
  assert.equal(await t.record(), undefined);
});

test("a different task in the same thread gets its own assessment", async () => {
  const t = await setup("把按钮颜色改成红色");
  await t.hook(t.context()); await t.queue(); await t.submit();
  await t.hook(t.context(true));
  const first = (await t.record())!.requestId;
  await t.harness.behavior.emitThreadEvent("message.dispatched", { entry: t.row });
  const ctx = t.context();
  const nextTask = "实现完整的登录流程";
  const decision = await t.hook({ ...ctx, input: { text: nextTask, blocks: [{ type: "text", text: nextTask, mentions: [] }] } });
  assert.equal(decision.action, "wait");
  assert.notEqual((await t.record())!.requestId, first);
});
