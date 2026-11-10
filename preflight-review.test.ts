import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { registerPreflight, type Preflight, type WorkflowRunner } from "./preflight.ts";
import type { Goal } from "./contract.ts";

const MAIN = "thr-review-main";
const CONTROLLER = "thr-review-controller";
const PLUGIN = "goal-loop";
const text = "Implement a complete data migration plan without running the migration.";
const context = (task = text) => makeMessageDispatchHookContext({
  thread: { id: MAIN },
  requestedExecution: { providerId: "claude-code" },
  input: { text: task, blocks: [{ type: "text", text: task, mentions: [] }] },
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(overrides: Partial<WorkflowRunner> = {}, initialTask = text) {
  let goal: Goal | undefined;
  const { bb, harness } = createFakePluginHost({
    pluginId: PLUGIN,
    sdk: { threads: {
      getPluginMetadata: async () => ({ targetThreadId: MAIN }),
      timeline: async () => ({ extensionStates: {} }) as never,
      get: async ({ threadId }) => makeThreadResponse({
        id: threadId,
        lifecycleOwnerThreadId: threadId === "thr-worker" ? CONTROLLER : MAIN,
        originPluginId: threadId === "thr-worker" ? "workflows" : PLUGIN,
        status: "idle",
      }),
      stop: async () => undefined as never,
      archive: async () => undefined as never,
    } },
  });
  const preflight = registerPreflight(bb, {
    read: async () => goal,
    prepare: async (_thread, taskId, objective) => {
      goal = { taskId, objective, status: "prepared", round: 1, maxRounds: 256, blocker: null, note: null, lastTurnSeq: 0 };
    },
    activate: async () => { if (goal) goal.status = "active"; },
    removePrepared: async (_thread, taskId) => {
      if (goal?.status === "prepared" && goal.taskId === taskId) goal = undefined;
    },
  }, async () => true, {
    start: async () => ({ runId: "run-review" }),
    status: async () => ({ id: "run-review", status: "running" }),
    stop: async () => ({ runId: "run-review", stopped: true }),
    ...overrides,
  });
  const dispatch = (task = initialTask) => harness.inspection.registrations.hooks["message.dispatch"]!(context(task));
  await dispatch();
  const created = (await preflight.read(MAIN))!;
  const seed = async (changes: Partial<Preflight>) => {
    const record = { ...created, ...changes };
    await bb.storage.kv.set(`preflight:${MAIN}`, record);
    return record;
  };
  const idle = () => harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: CONTROLLER, originPluginId: PLUGIN }),
    lastAssistantText: null,
  });
  return { bb, harness, preflight, created, seed, dispatch, idle };
}

test("concurrent controller idle events start only one preflight workflow", async () => {
  const gate = deferred();
  let starts = 0;
  const app = await setup({ start: async () => {
    starts += 1;
    await gate.promise;
    return { runId: "run-review" };
  } });
  await app.seed({ state: "running", controllerId: CONTROLLER });
  const first = app.idle();
  const second = app.idle();
  await tick();
  const observed = starts;
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(observed, 1);
});

test("a workflow start reply cannot overwrite a registered decision", async () => {
  const gate = deferred();
  const app = await setup({ start: async () => {
    await gate.promise;
    return { runId: "run-review" };
  } });
  await app.seed({ state: "running", controllerId: CONTROLLER });
  const starting = app.idle();
  await tick();
  const completing = app.preflight.complete(MAIN, app.created.requestId, {
    upperEstimateMinutes: 30, needsGoal: true, objective: text, reason: "Migration plan.",
  }, "thr-worker");
  await tick();
  gate.resolve();
  await Promise.all([starting, completing]);
  assert.equal((await app.preflight.read(MAIN))?.state, "ready");
});

test("resending the same text after cancellation creates a new preflight", async () => {
  const app = await setup();
  await app.preflight.cancel(MAIN);
  await app.dispatch();
  const next = (await app.preflight.read(MAIN))!;
  assert.equal(next.state, "pending");
  assert.notEqual(next.requestId, app.created.requestId);
});

test("retry cannot replace a different user task that arrives during cleanup", async () => {
  const gate = deferred();
  const app = await setup({ stop: async () => {
    await gate.promise;
    return { runId: "run-review", stopped: true };
  } });
  await app.seed({ state: "failed", controllerId: CONTROLLER, runId: "run-review" });
  const retrying = app.preflight.retry(MAIN);
  await tick();
  const newTask = "Build a new storefront search workflow.";
  const dispatching = app.dispatch(newTask);
  await tick();
  gate.resolve();
  const outcomes = await Promise.allSettled([retrying, dispatching]);
  assert.equal(outcomes[1].status, "fulfilled");
  if (outcomes[0].status === "rejected") assert.equal(outcomes[0].reason.code, "preflight_stale");
  assert.equal((await app.preflight.read(MAIN))?.task, newTask);
});

test("a controller that fails before spawn returns does not leave preflight running forever", async () => {
  const app = await setup();
  app.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: CONTROLLER, originPluginId: PLUGIN, status: "error" }));
  app.harness.sdk.stub("threads.spawn", async () => {
    await app.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: CONTROLLER, originPluginId: PLUGIN, status: "error" }),
      error: "Provider start failed.",
    });
    return makeThreadResponse({ id: CONTROLLER, originPluginId: PLUGIN, status: "error" });
  });
  await app.harness.behavior.emitThreadEvent("message.queued", {
    entry: makeQueueEntry({ id: "queue-review", threadId: MAIN, waitingOn: { kind: "plugin", pluginId: PLUGIN, reason: "Preflight" } }),
  });
  assert.equal((await app.preflight.read(MAIN))?.state, "failed");
});

test("a changed queued task replaces an earlier prepared goal instead of waiting forever", async () => {
  const app = await setup();
  await app.seed({ state: "running", controllerId: CONTROLLER });
  await app.preflight.complete(MAIN, app.created.requestId, {
    upperEstimateMinutes: 30, needsGoal: true, objective: text, reason: "Migration plan.",
  }, "thr-worker");
  const newTask = text + "\nAlso design the migration rollback checks.";
  await app.dispatch(newTask);
  const next = (await app.preflight.read(MAIN))!;
  assert.equal(next.task, newTask);
  assert.equal(next.state, "pending");
  assert.notEqual(next.requestId, app.created.requestId);
});

test("a second registration cannot downgrade an already prepared task", async () => {
  const app = await setup({}, "Change the dialog title.");
  const request = await app.seed({ state: "running", controllerId: CONTROLLER });
  const first = { upperEstimateMinutes: 20, needsGoal: true, objective: request.task, reason: "Needs investigation." };
  await app.preflight.complete(MAIN, request.requestId, first, "thr-worker");
  try {
    await app.preflight.complete(MAIN, request.requestId, {
      upperEstimateMinutes: 2, needsGoal: false, objective: request.task, reason: "Short task.",
    }, "thr-worker");
  } catch {
    // Rejecting the inconsistent replay is also safe.
  }
  assert.equal((await app.preflight.read(MAIN))?.decision?.needsGoal, true);
});

test("a substantial design question is assessed even when it starts with a question word", async () => {
  const app = await setup();
  const design = "请问整个多租户系统的完整架构应该怎样设计？请给出可交付的方案。";
  const decision = await app.dispatch(design);
  assert.equal(decision.action, "wait");
  assert.equal((await app.preflight.read(MAIN))?.task, design);
});

test("a normal queue group containing a user task is assessed despite a mixed origin", async () => {
  const app = await setup();
  await app.preflight.cancel(MAIN);
  const userBlock = { type: "text" as const, text, mentions: [] };
  const notice = { type: "text" as const, text: "Controller finished.", mentions: [] };
  const mixed = makeMessageDispatchHookContext({
    ...context(),
    initiator: "mixed",
    originPluginId: "mixed",
    senderThreadId: "mixed",
    input: { blocks: [userBlock, notice], text: text + "\n" + notice.text },
    queuedMessages: [
      makeQueueEntry({ id: "queue-user", threadId: MAIN, initiator: "user", originPluginId: null, content: [userBlock] }),
      makeQueueEntry({ id: "queue-notice", threadId: MAIN, initiator: "agent", originPluginId: "workflows", senderThreadId: CONTROLLER, content: [notice] }),
    ],
  });
  const decision = await app.harness.inspection.registrations.hooks["message.dispatch"]!(mixed);
  assert.equal(decision.action, "wait");
  assert.equal((await app.preflight.read(MAIN))?.state, "pending");
});

test("reload recovery detects a controller that failed while the plugin was unloaded", async () => {
  const app = await setup();
  await app.seed({ state: "running", controllerId: CONTROLLER });
  app.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: CONTROLLER, originPluginId: PLUGIN, status: "error" }));
  await app.harness.behavior.runService("preflight-recovery").done;
  assert.equal((await app.preflight.read(MAIN))?.state, "failed");
});
