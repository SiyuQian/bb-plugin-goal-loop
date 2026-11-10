import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { startWorkflow, workflowStatus, stopWorkflow } from "./runner.ts";

const context = {
  threadId: "thr_coordinator",
  projectId: "proj_feature",
  serverUrl: "http://127.0.0.1:38886",
  dataDir: "/tmp/private-bb-instance",
};

async function fakeCli(t: TestContext, body: string, usePath = false) {
  const directory = await mkdtemp(join(tmpdir(), "goal-loop-runner-"));
  const executable = join(directory, "bb");
  const capture = join(directory, "capture.json");
  await writeFile(executable, `#!/usr/bin/env node\n${body}\n`);
  await chmod(executable, 0o755);
  const previous = { BB_CLI: process.env.BB_CLI, PATH: process.env.PATH,
    GOAL_RUNNER_CAPTURE: process.env.GOAL_RUNNER_CAPTURE };
  if (usePath) {
    delete process.env.BB_CLI;
    process.env.PATH = `${directory}${process.platform === "win32" ? ";" : ":"}${previous.PATH}`;
  } else {
    process.env.BB_CLI = executable;
  }
  process.env.GOAL_RUNNER_CAPTURE = capture;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, capture };
}

test("start passes the exact source, arguments and coordinator context without a shell", async (t) => {
  const fixture = await fakeCli(t, `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.GOAL_RUNNER_CAPTURE, JSON.stringify({
      args: process.argv.slice(2),
      threadId: process.env.BB_THREAD_ID, projectId: process.env.BB_PROJECT_ID,
      serverUrl: process.env.BB_SERVER_URL, dataDir: process.env.BB_DATA_DIR,
      inherited: process.env.GOAL_RUNNER_CAPTURE
    }));
    process.stdout.write(JSON.stringify({ runId: 'wfr_preflight', name: 'preflight', status: 'queued' }));
  `);
  const marker = join(fixture.directory, "must-not-execute");
  const source = `export const meta = { name: "preflight" };\n// $(touch ${marker}) \`touch ${marker}\` 中文`;
  const args = { objective: "quotes \" ' ` $()\n第二行", count: 2 };
  assert.deepEqual(await startWorkflow({ ...context, source, args }), { runId: "wfr_preflight" });
  const actual = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.deepEqual(actual, {
    args: ["workflows", "run", "--script", source, "--args", JSON.stringify(args), "--json"],
    ...context,
    inherited: fixture.capture,
  });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("status uses the configured server and preserves the result used for recovery", async (t) => {
  await fakeCli(t, `
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2), ['workflows', 'status', 'wfr_preflight', '--json']);
    assert.equal(process.env.BB_THREAD_ID, 'thr_coordinator');
    assert.equal(process.env.BB_PROJECT_ID, 'proj_feature');
    process.stdout.write(JSON.stringify({ id: 'wfr_preflight', status: 'completed',
      resultAvailable: true, result: { approved: true }, error: null }));
  `);
  assert.deepEqual(await workflowStatus({ ...context, runId: "wfr_preflight" }), {
    id: "wfr_preflight", status: "completed", resultAvailable: true,
    result: { approved: true }, error: null,
  });
});

test("stop cancels the requested run and works with bare bb on PATH", async (t) => {
  await fakeCli(t, `
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2), ['workflows', 'stop', 'wfr_preflight', '--json']);
    assert.equal(process.env.BB_THREAD_ID, 'thr_coordinator');
    assert.equal(process.env.BB_PROJECT_ID, 'proj_feature');
    process.stdout.write(JSON.stringify({ runId: 'wfr_preflight', stopped: true }));
  `, true);
  assert.deepEqual(await stopWorkflow({ ...context, runId: "wfr_preflight" }), {
    runId: "wfr_preflight", stopped: true,
  });
});

test("invalid CLI responses cannot pass as a created or inspected workflow", async (t) => {
  await fakeCli(t, `process.stdout.write(process.env.GOAL_RUNNER_REPLY);`);
  const previous = process.env.GOAL_RUNNER_REPLY;
  t.after(() => {
    if (previous === undefined) delete process.env.GOAL_RUNNER_REPLY;
    else process.env.GOAL_RUNNER_REPLY = previous;
  });
  for (const reply of ["not JSON", "null", "{}", '{"runId":""}', '{"runId":3}']) {
    process.env.GOAL_RUNNER_REPLY = reply;
    await assert.rejects(startWorkflow({ ...context, source: "source", args: {} }), /invalid/i);
  }
  for (const reply of ["null", "{}", '{"id":"wrong-run","status":"completed"}',
    '{"id":"wfr_preflight","status":3}']) {
    process.env.GOAL_RUNNER_REPLY = reply;
    await assert.rejects(workflowStatus({ ...context, runId: "wfr_preflight" }), /invalid/i);
  }
  process.env.GOAL_RUNNER_REPLY = '{"runId":"wfr_preflight","stopped":"true"}';
  await assert.rejects(stopWorkflow({ ...context, runId: "wfr_preflight" }), /invalid/i);
});

test("CLI failures report the operation without exposing the command, task or stderr", async (t) => {
  await fakeCli(t, `process.stderr.write('secret-header-value'); process.exit(7);`);
  const failure = await startWorkflow({ ...context, source: "private-source", args: { task: "private-task" } })
    .catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /workflow.*run.*7/i);
  assert.doesNotMatch(String(failure.stack), /secret-header-value|private-source|private-task/);
});

test("an aborted request never starts a workflow subprocess", async (t) => {
  const fixture = await fakeCli(t, `require('node:fs').writeFileSync(process.env.GOAL_RUNNER_CAPTURE, 'started');`);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startWorkflow({ ...context, source: "source", args: {}, signal: controller.signal }),
    { name: "AbortError" });
  await assert.rejects(readFile(fixture.capture), { code: "ENOENT" });
});

test("cancelling an active CLI request terminates its subprocess", async (t) => {
  const fixture = await fakeCli(t, `
    require('node:fs').writeFileSync(process.env.GOAL_RUNNER_CAPTURE, String(process.pid));
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  const pending = startWorkflow({ ...context, source: "private-source", args: {}, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  let pid: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await readFile(fixture.capture, "utf8").catch(() => undefined);
    if (value !== undefined) { pid = Number(value); break; }
    await setTimeout(10);
  }
  controller.abort();
  await rejected;
  assert.ok(pid, "fake CLI started before cancellation");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); }
    catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
    await setTimeout(10);
  }
  assert.fail("cancelled CLI process still running");
});
