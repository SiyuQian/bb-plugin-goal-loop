import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { buildPreflightWorkflow } from "./workflow.ts";

const task = {
  threadId: "thr_feature",
  requestId: "req_feature",
  task: "Review the migration and write a plan. Do not implement it.",
  suspectedLongTask: false,
};
const small = {
  upperEstimateMinutes: 4,
  needsGoal: false,
  objective: "Explain the configuration value.",
  reason: "A short explanation with no changes.",
};

interface AgentCall {
  prompt: string;
  options: { schema?: unknown; phase?: string };
}

async function run(
  classification: unknown,
  input: unknown = task,
  setup: unknown = "Submitted for server validation.",
  pluginId = "goal-loop",
) {
  const calls: AgentCall[] = [];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(
    "args", "agent", "phase",
    buildPreflightWorkflow(pluginId).replace(/^export const meta\s*=/, "const meta ="),
  );
  const pending = execute(input, async (prompt: string, options: AgentCall["options"]) => {
    calls.push({ prompt, options });
    if (calls.length === 1) return classification;
    if (setup instanceof Error) throw setup;
    return setup;
  }, () => {});
  return { calls, pending };
}

test("a short task submits the decision to the originating request", async () => {
  const { calls, pending } = await run(small);
  const result = await pending;
  assert.deepEqual(result.decision, small);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].options.schema);
  assert.equal(result.submission, "Submitted for server validation.");
  assert.ok(calls[0].prompt.includes(task.task));
  assert.ok(calls[1].prompt.includes("preflight-complete"));
  assert.ok(calls[1].prompt.includes("req_feature"));
});

test("15 minutes requires a goal even when the classifier says false", async () => {
  const { pending } = await run({ ...small, upperEstimateMinutes: 15 });
  assert.equal((await pending).decision.needsGoal, true);
});

test("server suspicion overrides a classifier's short estimate", async () => {
  const { pending } = await run(small, { ...task, suspectedLongTask: true });
  assert.equal((await pending).decision.needsGoal, true);
});

test("classifier uncertainty can require a goal below 15 minutes", async () => {
  const { pending } = await run({ ...small, needsGoal: true });
  assert.equal((await pending).decision.needsGoal, true);
});

test("missing or invalid classifier results never reach the registration worker", async () => {
  for (const invalid of [
    null, undefined, "needs a goal", {},
    { ...small, upperEstimateMinutes: "4" },
    { ...small, upperEstimateMinutes: -1 },
    { ...small, upperEstimateMinutes: Infinity },
    { ...small, needsGoal: "false" },
    { ...small, objective: " " },
    { ...small, reason: "" },
    { ...small, unexpected: true },
  ]) {
    const { calls, pending } = await run(invalid);
    await assert.rejects(pending, /invalid.*decision/i);
    assert.equal(calls.length, 1);
  }
});

test("an invalid originating request never starts an assessment worker", async () => {
  for (const input of [null, { ...task, requestId: "" }, { ...task, suspectedLongTask: undefined }]) {
    const { calls, pending } = await run(small, input);
    await assert.rejects(pending, /invalid.*request/i);
    assert.equal(calls.length, 0);
  }
});

test("registration failure leaves the workflow failed", async () => {
  const { pending } = await run(small, task, new Error("request is stale"));
  await assert.rejects(pending, /request is stale/);
});

test("the registration command preserves JSON and cannot execute task text", async () => {
  const objective = "Plan user's migration; preserve $(printf secret) and `id`.";
  const classification = { ...small, objective, reason: "User's request is planning only." };
  const { calls, pending } = await run(classification, task, "Submitted", "goal-loop-test");
  await pending;
  const command = calls[1].prompt.split("\n").find((line) => line.startsWith("bb plugin run "));
  assert.ok(command);
  // Replace only the external bb process; the real shell still parses every argument.
  const captured = execFileSync("/bin/sh", ["-c", "bb() { printf '%s\\0' \"$@\"; }; " + command]);
  const argv = captured.toString().split("\0").slice(0, -1);
  assert.deepEqual(argv.slice(0, 7), ["plugin", "run", "goal-loop-test", "preflight-complete", "--thread", "thr_feature", "--request"]);
  assert.equal(argv[7], "req_feature");
  assert.equal(argv[8], "--decision");
  assert.deepEqual(JSON.parse(argv[9]), classification);
});
