import { createHash, randomUUID } from "node:crypto";
import { PluginCliError, type BbPluginApi, type MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Goal } from "./contract.ts";
import { buildPreflightWorkflow } from "./workflow.ts";
import { startWorkflow, stopWorkflow, workflowStatus } from "./runner.ts";

export const decisionSchema = z.object({
  upperEstimateMinutes: z.number().finite().min(0),
  needsGoal: z.boolean(),
  objective: z.string().trim().min(1).max(8000),
  reason: z.string().trim().min(1).max(2000),
}).strict();

export interface Preflight {
  requestId: string;
  threadId: string;
  projectId: string;
  hash: string;
  task: string;
  suspectedLongTask: boolean;
  state: "pending" | "running" | "ready" | "released" | "consumed" | "failed" | "cancelled";
  queueIds: string[];
  controllerId: string | null;
  runId: string | null;
  decision: z.infer<typeof decisionSchema> | null;
  error: string | null;
  execution: MessageDispatchHookContext["requestedExecution"];
  environmentId: string | null;
  previousObjective?: string;
  previousGoal?: Goal;
}

export type WorkflowRunner = {
  start: typeof startWorkflow;
  status: typeof workflowStatus;
  stop: typeof stopWorkflow;
};

/** Obvious questions bypass the costly workflow; ambiguous action requests do not. */
export function needsAssessment(text: string): boolean {
  const task = text.trim();
  if (/^(你好|谢谢|好的|明白了|hi|hello|thanks|ok)[!！。.\s]*$/iu.test(task)) return false;
  const action = /实现|开发|修复|修改|重构|迁移|安装|更新|部署|执行|测试|改一下|加[一上个]|做[一整个]|implement|build|fix|refactor|migrat|deploy|install|update|execute|test/iu;
  if (action.test(task)) return true;
  return !/^(请问|为什么|是什么|怎么|怎样|解释|列出|介绍|对比|比较|总结|你觉得|你认为|你的计划|what\b|why\b|how\b|explain\b|list\b|compare\b)/iu.test(task);
}

export function suspectedLongTask(text: string): boolean {
  return /完整|整个|所有|全部|全面|端到端|迁移|重构|长期|持续|多\s*PR|前后端|一整套|whole|all\b|end.to.end|migrat|refactor|multi.stage|full\b|long.running/iu.test(text);
}

function fingerprint(context: MessageDispatchHookContext): string {
  return createHash("sha256").update(JSON.stringify(context.input)).digest("hex");
}

export async function nativeGoalActive(bb: BbPluginApi, threadId: string): Promise<boolean> {
  const timeline = await bb.sdk.threads.timeline({ threadId });
  const goal = timeline.extensionStates?.["provider-codex/goal"] as { status?: string } | null | undefined;
  return goal?.status === "active";
}

interface GoalControl {
  read(threadId: string): Promise<Goal | undefined>;
  prepare(threadId: string, taskId: string, objective: string, previousObjective?: string): Promise<Goal | void>;
  activate(threadId: string, taskId: string): Promise<void>;
  removePrepared(threadId: string, taskId: string, previousGoal?: Goal): Promise<void>;
}

export function registerPreflight(
  bb: BbPluginApi,
  goals: GoalControl,
  enabled: () => Promise<boolean>,
  runner: WorkflowRunner = { start: startWorkflow, status: workflowStatus, stop: stopWorkflow },
) {
  const key = (threadId: string) => `preflight:${threadId}`;
  const read = (threadId: string) => bb.storage.kv.get<Preflight>(key(threadId));
  const write = (record: Preflight) => bb.storage.kv.set(key(record.threadId), record);
  const lifecycle = new AbortController();
  bb.onDispose(() => lifecycle.abort());
  const chains = new Map<string, Promise<unknown>>();
  function locked<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const next = (chains.get(threadId) ?? Promise.resolve()).then(fn);
    chains.set(threadId, next.catch(() => undefined));
    return next;
  }
  const contextFor = (record: Preflight) => ({
    threadId: record.controllerId!, projectId: record.projectId,
    serverUrl: bb.server.loopbackBaseUrl, dataDir: bb.server.experimental_dataDir,
    signal: lifecycle.signal,
  });

  async function cleanup(record: Preflight) {
    if (!record.controllerId) return;
    try {
      if (record.runId) await runner.stop({ ...contextFor(record), runId: record.runId });
    } catch { /* A terminal run needs no cancellation. */ }
    await bb.sdk.threads.stop({ threadId: record.controllerId }).catch(() => undefined);
    await bb.sdk.threads.archive({ threadId: record.controllerId }).catch(() => undefined);
  }

  async function fail(record: Preflight, message: string) {
    await locked(record.threadId, async () => {
      const latest = await read(record.threadId);
      if (latest?.requestId !== record.requestId || !["pending", "running"].includes(latest.state)) return;
      latest.state = "failed";
      latest.error = message;
      await write(latest);
      await goals.removePrepared(record.threadId, record.requestId, latest.previousGoal);
    });
    await bb.experimental_hooks.recheck("message.dispatch");
  }

  async function launch(record: Preflight) {
    // This runs after message.queued, outside the dispatch checkpoint's lock.
    try {
      const controller = await bb.sdk.threads.spawn({
        projectId: record.projectId,
        ...(record.environmentId ? { parentThreadId: record.threadId } : {}),
        parentNotifications: "off",
        visibility: "hidden",
        title: "Goal preflight",
        environment: record.environmentId
          ? { type: "reuse", environmentId: record.environmentId }
          : { type: "project-default" },
        providerId: record.execution.providerId,
        ...(record.execution.model ? { model: record.execution.model } : {}),
        ...(record.execution.reasoningLevel ? { reasoningLevel: record.execution.reasoningLevel } : {}),
        ...(record.execution.permissionMode ? { permissionMode: record.execution.permissionMode } : {}),
        prompt: "Initialize a goal preflight controller. Reply READY only. Do not inspect or change files, call tools, or perform a user task. The workflow will be started by the plugin after this turn.",
        pluginMetadata: { targetThreadId: record.threadId, requestId: record.requestId },
      });
      await locked(record.threadId, async () => {
        const latest = await read(record.threadId);
        if (latest?.requestId !== record.requestId || latest.state !== "running") {
          await cleanup({ ...record, controllerId: controller.id });
          return;
        }
        latest.controllerId = controller.id;
        await write(latest);
        // A very fast controller may already have finished before spawn returned.
        const current = await bb.sdk.threads.get({ threadId: controller.id });
        if (current.status === "idle") await startRun(latest);
        else if (current.status === "error") throw new Error("Preflight controller failed during startup.");
      });
    } catch {
      await fail(record, "Could not start the preflight controller. Retry with bb goal preflight-retry.");
      const latest = await read(record.threadId);
      if (latest?.requestId === record.requestId) await cleanup(latest);
    }
  }

  async function startRun(record: Preflight) {
    if (record.runId || !record.controllerId || record.state !== "running") return;
    const started = await runner.start({
      ...contextFor(record),
      source: buildPreflightWorkflow(bb.pluginId),
      args: { threadId: record.threadId, requestId: record.requestId, task: record.task, suspectedLongTask: record.suspectedLongTask },
    });
    record.runId = started.runId;
    await write(record);
    bb.log.info(`Goal preflight ${record.requestId}: ::workflow-preview{run="${started.runId}"}`);
  }

  bb.experimental_hooks.on("message.dispatch", (context) => locked(context.thread.id, async () => {
    if (!(await enabled()) || context.thread.originPluginId !== null || context.parentThreadId !== null || (context.initiator !== "user" && context.initiator !== "mixed")) return { action: "proceed" };
    const hash = fingerprint(context);
    let record = await read(context.thread.id);
    if (record?.hash === hash && record.state !== "consumed" &&
      !(context.queuedMessages.length === 0 && ["failed", "cancelled"].includes(record.state))) {
      record.queueIds = [...new Set([...record.queueIds, ...context.queuedMessages.map(row => row.id)])];
      await write(record);
      if (record.state === "failed" || record.state === "cancelled") return { action: "wait", reason: record.error ?? "Goal preflight cancelled. Retry or remove this queued task." };
      if (record.state === "ready" || record.state === "released") {
        if (record.decision?.needsGoal) {
          const goal = await goals.read(record.threadId);
          if (!goal || goal.taskId !== record.requestId || goal.objective !== record.task || !["prepared", "active"].includes(goal.status)) return { action: "wait", reason: "Goal preflight has no matching goal. Retry the preflight." };
          if (await nativeGoalActive(bb, record.threadId)) return { action: "wait", reason: "A native Codex goal is active. Clear it before starting the plugin goal." };
        }
        record.state = "released";
        await write(record);
        return { action: "proceed" };
      }
      return { action: "wait", reason: "Goal preflight: estimating the task and preparing its goal before execution." };
    }
    const hasAttachments = context.input.blocks.some(block => block.type !== "text");
    if (!hasAttachments && !suspectedLongTask(context.input.text) && !needsAssessment(context.input.text)) return { action: "proceed" };
    if (record?.hash !== hash && record && ["pending", "running", "ready", "released"].includes(record.state)) {
      record.state = "cancelled";
      record.error = "Superseded by an updated queued task.";
      await write(record);
      void cleanup(record);
      await goals.removePrepared(record.threadId, record.requestId, record.previousGoal);
    }
    const goal = await goals.read(context.thread.id);
    if (goal?.status === "active" && /^(继续|继续执行|按计划继续|continue|resume)[。.!！\s]*$/iu.test(context.input.text.trim())) return { action: "proceed" };
    if (goal && !["complete", "active"].includes(goal.status)) return { action: "wait", reason: "The existing goal is paused or blocked. Resume or clear it before a new task." };
    if (await nativeGoalActive(bb, context.thread.id)) return { action: "wait", reason: "A native Codex goal is active. Clear it before starting the workflow-controlled task." };
    if (context.input.text.length > 32000) return { action: "reject", message: "Task exceeds the goal preflight limit. Put the specification in a file and send a shorter task." };
    record = {
      requestId: randomUUID(), threadId: context.thread.id, projectId: context.project.id,
      hash, task: (goal?.status === "active" ? `Existing objective:\n${goal.objective}\n\nAdditional user request:\n` : "") + (context.input.text.trim() || "Complete the task described in the user's attachments."),
      suspectedLongTask: hasAttachments || suspectedLongTask(context.input.text),
      state: "pending", queueIds: context.queuedMessages.map(row => row.id), controllerId: null, runId: null, decision: null, error: null,
      execution: context.requestedExecution, environmentId: context.environment?.id ?? null,
      ...(goal?.status === "active" ? { previousObjective: goal.objective } : {}),
    };
    await write(record);
    return { action: "wait", reason: "Goal preflight: checking whether this task may exceed 15 minutes." };
  }));

  bb.events.on("message.queued", async ({ entry }) => {
    if (entry.waitingOn?.kind !== "plugin" || entry.waitingOn.pluginId !== bb.pluginId) return;
    let toLaunch: Preflight | undefined;
    await locked(entry.threadId, async () => {
      const record = await read(entry.threadId);
      if (!record) return;
      record.queueIds = [...new Set([...record.queueIds, entry.id])];
      if (record.state === "pending") { record.state = "running"; toLaunch = record; }
      await write(record);
    });
    if (toLaunch) await launch(toLaunch);
  });

  async function cancel(threadId: string) {
    const record = await locked(threadId, async () => {
      const record = await read(threadId);
      if (!record || ["consumed", "failed", "cancelled"].includes(record.state)) return;
      record.state = "cancelled"; record.error = "Goal preflight cancelled by the user.";
      await write(record);
      await goals.removePrepared(threadId, record.requestId, record.previousGoal);
      return record;
    });
    if (record) await cleanup(record);
  }
  bb.events.on("message.cancelled", async ({ entry }) => {
    const record = await read(entry.threadId);
    if (record?.queueIds.includes(entry.id)) await cancel(entry.threadId);
  });
  bb.events.on("message.dispatched", async ({ entry }) => {
    await locked(entry.threadId, async () => {
      const record = await read(entry.threadId);
      if (record?.queueIds.includes(entry.id) && record.state === "released") {
        if (record.decision?.needsGoal) await goals.activate(record.threadId, record.requestId);
        record.state = "consumed";
        await write(record);
      }
    });
  });
  bb.events.on("thread.archived", ({ thread }) => cancel(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => cancel(thread.id));

  async function reconcileController(controllerId: string) {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: controllerId });
    if (typeof metadata?.targetThreadId !== "string") return;
    const record = await read(metadata.targetThreadId);
    if (!record || record.controllerId !== controllerId) return;
    try {
      if (!record.runId && record.state === "running") {
        await locked(record.threadId, async () => {
          const latest = await read(record.threadId);
          if (latest?.requestId === record.requestId && latest.state === "running" && !latest.runId) await startRun(latest);
        });
        return;
      }
      if (!record.runId) return;
      const status = await runner.status({ ...contextFor(record), runId: record.runId });
      if (["succeeded", "failed", "cancelled"].includes(status.status)) {
        if (record.state === "running") await fail(record, "Workflow ended without registering a verified decision. Retry the preflight.");
        await cleanup(record);
      }
    } catch {
      await fail(record, "Could not verify the preflight workflow. Retry the preflight.");
      await cleanup(record);
    }
  }
  bb.events.on("thread.idle", async ({ thread }) => {
    if (thread.originPluginId === bb.pluginId) await reconcileController(thread.id);
  });
  bb.events.on("thread.failed", async ({ thread }) => {
    if (thread.originPluginId !== bb.pluginId) return;
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id });
    if (typeof metadata?.targetThreadId !== "string") return;
    const record = await read(metadata.targetThreadId);
    if (record?.controllerId === thread.id) { await fail(record, "Preflight controller failed. Retry the preflight."); await cleanup(record); }
  });

  async function complete(threadId: string, requestId: string, input: unknown, callerThreadId?: string) {
    const decision = decisionSchema.parse(input);
    const result = await locked(threadId, async () => {
      const record = await read(threadId);
      if (!record || record.requestId !== requestId || !["running", "ready"].includes(record.state)) throw new PluginCliError("No matching live preflight request.", { code: "preflight_stale" });
      if (!callerThreadId) throw new PluginCliError("Only the workflow setup worker can register this decision.", { code: "preflight_caller" });
      const caller = await bb.sdk.threads.get({ threadId: callerThreadId });
      if (caller.lifecycleOwnerThreadId !== record.controllerId || caller.originPluginId !== "workflows") throw new PluginCliError("Decision is not from this preflight workflow.", { code: "preflight_caller" });
      if (record.state === "ready" && record.decision) return { requestId, needsGoal: record.decision.needsGoal };
      const normalized = { ...decision, needsGoal: decision.needsGoal || decision.upperEstimateMinutes >= 15 || record.suspectedLongTask || record.previousObjective !== undefined };
      if (await nativeGoalActive(bb, threadId)) throw new PluginCliError("Native Codex goal is active; refusing a second goal loop.", { code: "goal_conflict" });
      if (normalized.needsGoal) {
        const previous = await goals.prepare(threadId, requestId, record.task, record.previousObjective);
        if (previous) record.previousGoal = previous;
        const goal = await goals.read(threadId);
        if (goal?.status !== "prepared" || goal.taskId !== requestId || goal.objective !== record.task) throw new PluginCliError("The prepared goal could not be verified.", { code: "goal_not_prepared" });
      }
      record.decision = normalized; record.state = "ready"; record.error = null;
      await write(record);
      return { requestId, needsGoal: normalized.needsGoal };
    });
    await bb.experimental_hooks.recheck("message.dispatch");
    return result;
  }

  async function retry(threadId: string) {
    const record = await read(threadId);
    if (!record || !["failed", "cancelled"].includes(record.state)) throw new PluginCliError("No failed or cancelled preflight to retry.", { code: "preflight_not_retryable" });
    await cleanup(record);
    await locked(threadId, async () => {
      const latest = await read(threadId);
      if (latest?.requestId !== record.requestId || !["failed", "cancelled"].includes(latest.state)) throw new PluginCliError("The task changed while retrying. Retry the current task instead.", { code: "preflight_stale" });
      await write({ ...latest, requestId: randomUUID(), state: "pending", controllerId: null, runId: null, decision: null, error: null });
    });
    await bb.experimental_hooks.recheck("message.dispatch");
    let toLaunch: Preflight | undefined;
    await locked(threadId, async () => {
      const current = await read(threadId);
      if (current?.state === "pending") { current.state = "running"; await write(current); toLaunch = current; }
    });
    if (toLaunch) await launch(toLaunch);
  }

  bb.background.service("preflight-recovery", { async start(signal) {
    for (const storageKey of await bb.storage.kv.list("preflight:")) {
      if (signal.aborted) return;
      const record = await read(storageKey.slice("preflight:".length));
      if (!record) continue;
      if (record.state === "running" && !record.controllerId) await fail(record, "Preflight startup was interrupted. Retry the preflight.");
      else if (record.controllerId && ["running", "ready", "released", "consumed"].includes(record.state)) {
        const controller = await bb.sdk.threads.get({ threadId: record.controllerId }).catch(() => null);
        if (controller?.status === "idle") await reconcileController(controller.id);
        else if (record.state === "running" && (!controller || controller.status === "error")) {
          await fail(record, "Preflight controller was interrupted while the plugin was unavailable. Retry the preflight.");
          await cleanup(record);
        }
      }
    }
    await bb.experimental_hooks.recheck("message.dispatch");
  }});
  return { read, complete, retry, cancel };
}
