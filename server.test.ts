// Run: npm test (node --test, Node 22.18+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { AUTO_START, blockerStreak, type Goal } from "./server.ts";

const THREAD = "thr_goal";

interface SentInput {
  input: Array<{ text: string; visibility?: string }>;
}

/** A fake thread: each endTurn() finishes a turn and emits thread.idle. */
async function start(
  settings: Record<string, number> = {},
  stored: Record<string, unknown> = {},
) {
  const turn = { seq: 0, status: "completed" };
  const thread = {
    status: "idle" as "idle" | "active",
    queuedMessageCount: 0,
  };
  const sends: SentInput[] = [];
  const archived: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "goal-loop",
    settings,
    agentSkillIds: ["goal"],
    sdk: {
      threads: {
        events: {
          list: async () =>
            (turn.seq === 0
              ? []
              : [
                  {
                    id: `event-${turn.seq}`,
                    type: "turn/completed",
                    seq: turn.seq,
                    threadId: THREAD,
                    createdAt: 0,
                    scope: { kind: "thread" },
                    data: { status: turn.status, providerThreadId: null },
                  },
                ]) as never,
        },
        get: async () => makeThreadResponse({ id: THREAD, ...thread }),
        timeline: async () => ({ extensionStates: {} }) as never,
        send: async (args) => {
          sends.push(args as unknown as SentInput);
          // Like bb: a send waits for the dispatch hook, which may take the
          // plugin's thread lock. A round sent while holding it deadlocks.
          const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
          await Promise.race([
            hook(makeMessageDispatchHookContext({ thread: { id: THREAD }, initiator: "user" })),
            new Promise((_, reject) => setTimeout(() => reject(new Error("dispatch hook did not decide")), 500)),
          ]);
          return {} as never;
        },
        archive: async ({ threadId }) => {
          archived.push(threadId);
          return {} as never;
        },
      },
    },
  });
  for (const [key, value] of Object.entries(stored)) await bb.storage.kv.set(key, value);
  plugin(bb);

  const idle = () =>
    harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD }),
      lastAssistantText: null,
    });
  return {
    harness,
    sends,
    archived,
    thread,
    dispatch: (overrides: Parameters<typeof makeMessageDispatchHookContext>[0]) =>
      harness.inspection.registrations.hooks["message.dispatch"]!(
        makeMessageDispatchHookContext({ thread: { id: THREAD }, initiator: "user", ...overrides }),
      ),
    async tool(name: string, input: unknown) {
      const result = await harness.behavior.callAgentTool(name, input, {
        threadId: THREAD,
      });
      return typeof result === "string"
        ? { text: result, isError: false }
        : { text: result.content[0]?.type === "text" ? result.content[0].text : "", isError: result.isError === true };
    },
    async endTurn(status = "completed") {
      turn.seq += 1;
      turn.status = status;
      await idle();
    },
    idle,
    cli: (argv: string[]) =>
      harness.behavior.runCli(argv, { threadId: THREAD }),
    kv: bb.storage.kv,
    goal: async () => (await bb.storage.kv.get<Goal>(`goal:${THREAD}`))!,
  };
}

test("offers the tools to every provider on threads that no plugin spawned", async () => {
  const t = await start();
  const config = (overrides: Parameters<typeof makePluginAgentConfigurationContext>[0] = {}) =>
    t.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: THREAD }, ...overrides }),
    );
  const tools = async (overrides: Parameters<typeof makePluginAgentConfigurationContext>[0]) =>
    (await config(overrides)).tools.map((tool) => tool.name);
  for (const id of ["claude-code", "codex"]) {
    assert.deepEqual(await tools({ provider: { id } }), ["goal_loop_create", "goal_loop_update"]);
  }
  assert.deepEqual(await tools({ origin: { kind: "fork", pluginId: "side-chat" } }), []);
  assert.deepEqual(await tools({ thread: { parentThreadId: "thr_parent" } }), []);

  // With no goal, the agent is told to start one instead of stopping early.
  assert.equal((await config()).instructions, AUTO_START);
  await t.harness.behavior.setSettings({ autoGoal: false });
  assert.equal((await config()).instructions, null);

  // The old create_goal name still works for sessions that already have it.
  assert.match((await t.tool("create_goal", { objective: "Port the app" })).text, /Goal created/);
  assert.match((await config()).instructions ?? "", /active Goal Loop goal[\s\S]*> Port the app/);
});

test("ordinary messages are never held and start no goal", async () => {
  const t = await start();
  for (const experimental_submission of [null, { pluginId: "other", data: { goal: true } }]) {
    const decision = await t.dispatch({
      input: { text: "实现完整的多 PR 管理功能，包括前后端和端到端测试" },
      experimental_submission,
    });
    assert.deepEqual(decision, { action: "proceed" });
  }
  assert.equal(await t.goal(), undefined);
});

test("Send as goal starts a goal from the message; a second one is refused", async () => {
  const t = await start({ maxRounds: 3 });
  const asGoal = (text: string) =>
    t.dispatch({
      input: { text },
      experimental_submission: { pluginId: "goal-loop", data: { goal: true } },
    });
  assert.deepEqual(await asGoal("  Port the app  "), { action: "proceed" });
  assert.equal((await t.goal()).objective, "Port the app");
  assert.equal((await t.goal()).status, "active");

  const second = await asGoal("Other");
  assert.equal(second.action, "reject");
  assert.match((second as { message: string }).message, /unfinished goal \(active, round 1 of 3\)/);

  await t.endTurn(); // the user's goal message ends: round 2 starts
  assert.equal(t.sends[0]!.input[0]!.text, "Goal round 2/3");
  assert.match(t.sends[0]!.input[1]!.text, /> Port the app/);
});

test("a user reply resumes a blocked goal but not a paused one", async () => {
  const t = await start();
  await t.tool("goal_loop_create", { objective: "X" });
  for (let round = 1; round <= 3; round += 1) {
    await t.tool("goal_loop_update", { status: "blocked", blocker_key: "no-key", blocker_detail: "No API key." });
    if (round < 3) await t.endTurn();
  }
  assert.equal((await t.goal()).status, "blocked");

  await t.dispatch({ input: { text: "Key set." }, initiator: "agent" });
  assert.equal((await t.goal()).status, "blocked"); // only a user reply resumes it
  await t.dispatch({ input: { text: "Key set." } });
  assert.equal((await t.goal()).status, "active");
  assert.equal((await t.goal()).blocker, null);
  const sent = t.sends.length;
  await t.endTurn(); // the user's turn ends: the next round starts
  assert.equal(t.sends.length, sent + 1);

  await t.cli(["pause"]);
  await t.dispatch({ input: { text: "Hello" } });
  assert.equal((await t.goal()).status, "paused");
});

test("startup drops 0.1.1 preflight state and its prepared goals", async () => {
  const goal = (objective: string, status: string) => ({
    objective, taskId: "req_1", status, round: 4, maxRounds: 256, blocker: null, note: null, lastTurnSeq: 0,
  });
  // The usual case: the held task is gone, so the prepared goal goes too.
  const t = await start({}, {
    [`goal:${THREAD}`]: goal("Draw the diagram", "prepared"),
    [`preflight:${THREAD}`]: { state: "ready", controllerId: "thr_controller" },
  });
  await t.harness.behavior.runService("goal-recovery").done;
  assert.equal(await t.goal(), undefined);
  assert.deepEqual(t.archived, ["thr_controller"]);
  assert.deepEqual(await t.kv.list("preflight:"), []);
  await t.endTurn();
  assert.equal(t.sends.length, 0);

  // A prepared goal that replaced an active goal gives that goal back.
  const u = await start({}, {
    [`goal:${THREAD}`]: goal("Old objective + follow-up", "prepared"),
    [`preflight:${THREAD}`]: { state: "ready", controllerId: null, previousGoal: goal("Old objective", "active") },
  });
  await u.harness.behavior.runService("goal-recovery").done;
  assert.equal((await u.goal()).objective, "Old objective");
  assert.equal((await u.goal()).status, "active");
});

test("each completed turn starts the next round, up to the limit", async () => {
  const t = await start({ maxRounds: 3 });
  assert.match((await t.tool("goal_loop_create", { objective: "Port the app" })).text, /round 1 of 3/);
  assert.equal((await t.tool("goal_loop_create", { objective: "Other" })).isError, true);

  await t.endTurn();
  assert.equal(t.sends.length, 1);
  assert.equal(t.sends[0]!.input[0]!.text, "Goal round 2/3");
  assert.equal(t.sends[0]!.input[1]!.visibility, "agent-only");
  assert.match(t.sends[0]!.input[1]!.text, /> Port the app/);

  await t.idle(); // a repeated idle event for the same turn
  assert.equal(t.sends.length, 1);

  await t.endTurn(); // round 2 ends: round 3 starts
  await t.endTurn(); // round 3 ends: limit reached
  assert.equal(t.sends.length, 2);
  assert.equal((await t.goal()).status, "budgetLimited");

  assert.equal((await t.cli(["resume"])).exitCode, 1);
  assert.match((await t.cli(["resume", "--max-rounds", "5"])).stdout, /Round 4 of 5/);
});

test("waits when another message already started a turn", async () => {
  const t = await start();
  await t.tool("goal_loop_create", { objective: "X" });
  t.thread.status = "active";
  await t.endTurn();
  assert.equal(t.sends.length, 0);
  t.thread.status = "idle";
  await t.endTurn();
  assert.equal(t.sends.length, 1);
  assert.equal((await t.goal()).round, 2);
});

test("a stopped turn pauses the goal until bb goal resume", async () => {
  const t = await start();
  await t.tool("goal_loop_create", { objective: "X" });
  await t.endTurn("interrupted");
  assert.equal((await t.goal()).status, "paused");
  await t.endTurn(); // a later user turn does not resume it
  assert.equal(t.sends.length, 0);

  assert.match((await t.cli(["resume"])).stdout, /Round 2 of 256 started/);
  assert.equal((await t.goal()).status, "active");
  assert.equal(t.sends.length, 1);
  await t.idle(); // the interrupted turn is already handled
  assert.equal(t.sends.length, 1);
});

test("blocked needs the same blocker in 3 consecutive rounds", async () => {
  const t = await start();
  await t.tool("goal_loop_create", { objective: "X" });
  const block = async (key: string) =>
    (await t.tool("goal_loop_update", { status: "blocked", blocker_key: key, blocker_detail: "No API key." })).text;

  assert.match(await block("Missing API key"), /1 of 3/); // round 1
  assert.match(await block("missing-api-key"), /1 of 3/); // same round, same key
  await t.endTurn();
  assert.match(t.sends.at(-1)!.input[1]!.text, /Open blocker "missing-api-key"/);
  assert.match(await block("missing-api-key"), /2 of 3/); // round 2
  await t.endTurn(); // round 3 reports nothing: the run breaks
  await t.endTurn();
  assert.match(await block("missing-api-key"), /1 of 3/); // round 4
  await t.endTurn();
  assert.match(await block("missing-api-key"), /2 of 3/); // round 5
  await t.endTurn();
  assert.match(await block("missing-api-key"), /marked blocked/); // round 6
  assert.equal((await t.goal()).status, "blocked");
  assert.equal((await t.goal()).note, null); // the detail lives in blocker only

  const sent = t.sends.length;
  await t.endTurn();
  assert.equal(t.sends.length, sent);
  assert.equal(blockerStreak({ key: "a", detail: "", streak: 2, round: 1 }, "b", 2), 1);
});

test("complete needs evidence and ends the loop", async () => {
  const t = await start();
  await t.tool("goal_loop_create", { objective: "X" });
  assert.equal((await t.tool("goal_loop_update", { status: "complete" })).isError, true);
  assert.equal((await t.goal()).status, "active");

  assert.match(
    (await t.tool("goal_loop_update", { status: "complete", evidence: "All 40 tests pass." })).text,
    /marked complete/,
  );
  await t.endTurn();
  assert.equal(t.sends.length, 0);
  assert.equal((await t.cli(["resume"])).exitCode, 1);
  assert.match((await t.tool("goal_loop_create", { objective: "Next" })).text, /Goal created/);
});

test("the composer card reads and clears the goal over RPC", async () => {
  const t = await start();
  const rpc = (method: string) =>
    t.harness.behavior.callRpc(method, { threadId: THREAD });
  assert.equal(await rpc("goal_get"), null);
  await t.tool("goal_loop_create", { objective: "X" });
  assert.equal(((await rpc("goal_get")) as Goal).status, "active");
  assert.deepEqual(await rpc("goal_clear"), { cleared: true });
  assert.equal(await rpc("goal_get"), null);
  await t.endTurn();
  assert.equal(t.sends.length, 0);
});

test("the card's Pause and Resume buttons go through RPC", async () => {
  const t = await start();
  const rpc = (method: string) =>
    t.harness.behavior.callRpc(method, { threadId: THREAD });
  await assert.rejects(rpc("goal_pause"), { code: "not_found" });
  await t.tool("goal_loop_create", { objective: "X" });

  await rpc("goal_pause");
  assert.equal((await t.goal()).status, "paused");
  await t.endTurn();
  assert.equal(t.sends.length, 0);

  const resumed = (await rpc("goal_resume")) as { message: string };
  assert.match(resumed.message, /Round 2 of 256 started/);
  assert.equal((await t.goal()).status, "active");
  assert.equal(t.sends.length, 1);

  await t.tool("goal_loop_update", { status: "complete", evidence: "Done." });
  await assert.rejects(rpc("goal_resume"), { code: "conflict" });
});

test("bb goal pause and clear", async () => {
  const t = await start();
  await t.tool("goal_loop_create", { objective: "X" });
  await t.cli(["pause"]);
  await t.endTurn();
  assert.equal(t.sends.length, 0);
  assert.match((await t.cli(["status"])).stdout, /Goal: paused, round 1 of 256/);
  await t.cli(["clear"]);
  assert.equal((await t.cli(["status", "--json"])).stdout, "null");
});
