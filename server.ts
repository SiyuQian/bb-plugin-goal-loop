// bb-plugin-goal-loop: durable goals for agent threads.
//
// The agent calls create_goal when the user asks for a long-running
// objective. Each time a turn of that thread completes, the plugin starts the
// next round, up to the round limit (default 256). update_goal ends the loop:
// "complete" needs evidence, and "blocked" is accepted only after the same
// blocker_key is reported in 3 consecutive rounds. A turn that does not
// complete (the user pressed Stop, a restart) pauses the goal.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BLOCKED_AFTER_ROUNDS,
  goalTag,
  rpcContract,
  type Goal,
} from "./contract.ts";

export type { Goal } from "./contract.ts";

const INSTRUCTIONS = `Goal mode (create_goal, update_goal):
- When the user asks for a long-running objective, call create_goal before you start the work, even if the user does not say "goal". A long-running objective needs several rounds of work. Examples: a migration, a refactor across many files, "keep going until all tests pass", a multi-step build or research task.
- Do not call create_goal for a question, a small change, or a task that one turn can finish.
- While a goal is active, BB starts a new round each time you stop, up to the round limit. In each round, do the next concrete step. Do not wait for the user.
- Call update_goal with status "complete" only when the whole objective is done and verified. Do not mark it complete to stop early, because rounds are running out, or while work remains.
- Call update_goal with status "blocked" only for an obstacle that stops all progress. BB accepts it only after the same blocker_key is reported in ${BLOCKED_AFTER_ROUNDS} consecutive rounds. Before you report the same blocker again, try a different approach.`;

export function normalizeBlockerKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** Consecutive rounds, including `round`, that reported blocker `key`. */
export function blockerStreak(
  previous: Goal["blocker"],
  key: string,
  round: number,
): number {
  if (previous === null || previous.key !== key) return 1;
  if (previous.round === round) return previous.streak;
  return previous.round === round - 1 ? previous.streak + 1 : 1;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** The agent-only part of a continuation message. */
export function roundPrompt(goal: Goal): string {
  const lines = [
    `Round ${goal.round} of ${goal.maxRounds} for the active goal. BB started this round because your last turn ended.`,
    "",
    "Objective (recorded by create_goal):",
    quote(goal.objective),
    "",
  ];
  const blocker = goal.blocker;
  if (blocker !== null && blocker.round === goal.round - 1) {
    lines.push(
      `Open blocker "${blocker.key}": reported in ${blocker.streak} of the ${BLOCKED_AFTER_ROUNDS} consecutive rounds needed. Last report: ${blocker.detail}`,
      `Try a different way around it first. If it still stops all progress this round, report it again with blocker_key "${blocker.key}". If you get past it, do not report it. The count then resets.`,
      "",
    );
  }
  lines.push(
    "Do the next concrete step now. Do not wait for the user.",
    '- When the whole objective is done and verified, call update_goal with status "complete" and the evidence.',
    `- If an obstacle stops all progress, call update_goal with status "blocked". BB accepts it only after ${BLOCKED_AFTER_ROUNDS} consecutive rounds report the same blocker_key.`,
    "- Otherwise keep working. BB starts the next round when you stop.",
  );
  return lines.join("\n");
}

export function describeGoal(goal: Goal): string {
  const lines = [
    `Goal: ${goal.status}, round ${goal.round} of ${goal.maxRounds}`,
    `Objective: ${goal.objective}`,
  ];
  if (goal.blocker !== null) {
    lines.push(
      `Blocker: "${goal.blocker.key}", ${goal.blocker.streak} of ${BLOCKED_AFTER_ROUNDS} consecutive rounds (last in round ${goal.blocker.round}): ${goal.blocker.detail}`,
    );
  }
  if (goal.note !== null) lines.push(`Note: ${goal.note}`);
  return lines.join("\n");
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    maxRounds: {
      type: "number",
      label: "Round limit",
      description:
        "The most rounds a new goal runs before it stops as round-limited. Raise it for one goal with bb goal resume --max-rounds.",
      default: 256,
      experimental_schema: z.number().int().min(1).max(100_000),
    },
  });

  // Every write refreshes the composer card (app.tsx) through the RPC tag.
  const storageKey = (threadId: string) => `goal:${threadId}`;
  const load = (threadId: string) =>
    bb.storage.kv.get<Goal>(storageKey(threadId));
  async function save(threadId: string, goal: Goal): Promise<void> {
    await bb.storage.kv.set(storageKey(threadId), goal);
    bb.rpc.experimental_invalidate([goalTag(threadId)]);
  }
  /** Deletes the thread's goal. Returns false when it had none. */
  async function clear(threadId: string): Promise<boolean> {
    if ((await load(threadId)) === undefined) return false;
    await bb.storage.kv.delete(storageKey(threadId));
    bb.rpc.experimental_invalidate([goalTag(threadId)]);
    return true;
  }

  // Tool calls, idle events and CLI commands all read-modify-write one goal.
  // Run them one at a time per thread.
  const chains = new Map<string, Promise<unknown>>();
  function locked<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const run = (chains.get(threadId) ?? Promise.resolve()).then(task);
    chains.set(
      threadId,
      run.catch(() => undefined),
    );
    return run;
  }

  async function latestTurn(threadId: string) {
    const [row] = await bb.sdk.threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
    });
    return row?.type === "turn/completed"
      ? { seq: row.seq, status: row.data.status }
      : null;
  }

  /** True when nothing else is about to start a turn on the thread. */
  async function canStartRound(threadId: string): Promise<boolean> {
    const thread = await bb.sdk.threads.get({ threadId });
    return (
      (thread.status === "idle" || thread.status === "error") &&
      thread.queuedMessageCount === 0
    );
  }

  async function sendRound(threadId: string, goal: Goal): Promise<void> {
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: [
        {
          type: "text",
          text: `Goal round ${goal.round}/${goal.maxRounds}`,
          mentions: [],
        },
        {
          type: "text",
          text: roundPrompt(goal),
          mentions: [],
          visibility: "agent-only",
        },
      ],
    });
  }

  /** Acts on a finished turn: start the next round, pause, or stop at the limit. */
  async function continueGoal(threadId: string): Promise<void> {
    if ((await load(threadId))?.status !== "active") return;
    await locked(threadId, async () => {
      const goal = await load(threadId);
      if (goal?.status !== "active") return;
      const turn = await latestTurn(threadId);
      if (turn === null || turn.seq <= goal.lastTurnSeq) return;
      goal.lastTurnSeq = turn.seq;
      if (turn.status !== "completed") {
        goal.status = "paused";
        goal.note = `The last turn ended as "${turn.status}" (for example, the user pressed Stop). Resume it from the goal card or with "bb goal resume".`;
      } else if (goal.round >= goal.maxRounds) {
        goal.status = "budgetLimited";
        goal.note = `Used all ${goal.maxRounds} rounds. Run "bb goal resume --max-rounds <n>" to allow more.`;
      } else if (await canStartRound(threadId)) {
        goal.round += 1;
        try {
          await sendRound(threadId, goal);
        } catch (error) {
          goal.round -= 1;
          goal.status = "paused";
          goal.note = `Could not start round ${goal.round + 1}: ${String(error)}`;
        }
      }
      // Otherwise another message already started a turn. When that turn
      // ends, the next idle event continues the goal.
      await save(threadId, goal);
    });
  }

  bb.agents.registerTool({
    name: "create_goal",
    description:
      'Start a durable goal for this thread. After this call, BB starts a new round each time you stop, until you mark the goal "complete" or "blocked" with update_goal, or the round limit is reached. Call it when the user\'s request is a long-running objective, even if the user does not say "goal".',
    instructions: INSTRUCTIONS,
    presentation: {
      label: { pending: "Creating goal", completed: "Created goal" },
    },
    parameters: z.object({
      objective: z
        .string()
        .trim()
        .min(1)
        .max(8000)
        .describe(
          "The full objective in the user's terms, including what counts as done.",
        ),
    }),
    async execute({ objective }, { threadId }) {
      return locked(threadId, async () => {
        const current = await load(threadId);
        if (current?.status === "active") {
          return toolError(
            `This thread already has an active goal (round ${current.round} of ${current.maxRounds}). Keep working on it, and end it with update_goal. Objective:\n${quote(current.objective)}`,
          );
        }
        const goal: Goal = {
          objective,
          status: "active",
          round: 1,
          maxRounds: (await settings.get()).maxRounds,
          blocker: null,
          note: null,
          lastTurnSeq: (await latestTurn(threadId))?.seq ?? 0,
        };
        await save(threadId, goal);
        return `Goal created. This is round 1 of ${goal.maxRounds}. Start the work now. Each time you stop, BB starts the next round until you call update_goal.`;
      });
    },
  });

  bb.agents.registerTool({
    name: "update_goal",
    description: `Mark the active goal "complete" or "blocked". "complete": only when the whole objective is done and verified; give the evidence. "blocked": only for an obstacle that stops all progress; give blocker_key and blocker_detail. BB marks the goal blocked only after the same blocker_key is reported in ${BLOCKED_AFTER_ROUNDS} consecutive rounds. Before that, the goal stays active and the next round starts.`,
    presentation: {
      label: { pending: "Updating goal", completed: "Updated goal" },
    },
    parameters: z.object({
      status: z.enum(["complete", "blocked"]),
      evidence: z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .optional()
        .describe(
          'Required for "complete": what you did, and how you verified each part of the objective.',
        ),
      blocker_key: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .optional()
        .describe(
          'Required for "blocked": a short, stable id for the obstacle, such as "missing-api-key". Use the same key while the same obstacle remains.',
        ),
      blocker_detail: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          'Required for "blocked": what stops progress, and what you tried this round.',
        ),
    }),
    async execute(input, { threadId }) {
      return locked(threadId, async () => {
        const goal = await load(threadId);
        if (goal?.status !== "active") {
          return toolError(
            goal === undefined
              ? "This thread has no goal. Call create_goal first."
              : `The goal is "${goal.status}", not active. update_goal changes only an active goal.`,
          );
        }
        if (input.status === "complete") {
          if (input.evidence === undefined) {
            return toolError(
              'status "complete" needs evidence: what you did, and how you verified each part of the objective.',
            );
          }
          goal.status = "complete";
          goal.note = input.evidence;
          goal.blocker = null;
          await save(threadId, goal);
          return `Goal marked complete in round ${goal.round}. BB starts no more rounds. Give the user a short summary of the result.`;
        }
        const key = normalizeBlockerKey(input.blocker_key ?? "");
        if (key === "" || input.blocker_detail === undefined) {
          return toolError(
            'status "blocked" needs blocker_key and blocker_detail.',
          );
        }
        const streak = blockerStreak(goal.blocker, key, goal.round);
        goal.blocker = {
          key,
          detail: input.blocker_detail,
          streak,
          round: goal.round,
        };
        if (streak >= BLOCKED_AFTER_ROUNDS) {
          // The blocker already holds the detail; a copy in note shows twice.
          goal.status = "blocked";
          await save(threadId, goal);
          return `Goal marked blocked: "${key}" was reported in ${streak} consecutive rounds. BB starts no more rounds. Tell the user what blocks the goal and what they must do. After they fix it, they can resume it from the goal card or with "bb goal resume".`;
        }
        await save(threadId, goal);
        return `Not blocked yet: "${key}" is at ${streak} of ${BLOCKED_AFTER_ROUNDS} consecutive rounds. The goal stays active, and BB starts the next round when you stop. Try a different approach. If the same obstacle still stops you next round, report it again with blocker_key "${key}".`;
      });
    },
  });

  // Codex threads use Codex's native goals. Child threads and threads that a
  // plugin spawned (workflow workers, side chats) must finish in one run:
  // their caller reads each stop as the result.
  bb.agents.configure((context) => {
    const offer =
      context.provider.id !== "codex" &&
      context.origin.pluginId === null &&
      context.thread.parentThreadId === null;
    return {
      tools: offer ? ["create_goal", "update_goal"] : [],
      skills: offer ? ["goal"] : [],
    };
  });

  bb.events.on("thread.idle", ({ thread }) => continueGoal(thread.id));
  bb.events.on("thread.deleted", async ({ thread }) => {
    await clear(thread.id);
  });

  async function requireGoal(threadId: string): Promise<Goal> {
    const goal = await load(threadId);
    if (goal !== undefined) return goal;
    throw new PluginCliError(`Thread ${threadId} has no goal.`, {
      code: "goal_not_found",
    });
  }

  // The CLI and the card's buttons share pauseGoal and resumeGoal. They throw
  // PluginCliError; the RPC handlers turn it into a refusal.
  function pauseGoal(threadId: string): Promise<string> {
    return locked(threadId, async () => {
      const goal = await requireGoal(threadId);
      if (goal.status !== "active") {
        return `The goal is "${goal.status}". Nothing to pause.`;
      }
      goal.status = "paused";
      goal.note = "Paused by the user.";
      await save(threadId, goal);
      return 'Goal paused. Resume it from the goal card or with "bb goal resume".';
    });
  }

  function resumeGoal(threadId: string, maxRounds?: number): Promise<string> {
    return locked(threadId, async () => {
      const goal = await requireGoal(threadId);
      if (goal.status === "active") return "The goal is already active.";
      if (goal.status === "complete") {
        throw new PluginCliError("The goal is complete.", {
          code: "goal_complete",
          hint: "Ask the agent to create a new goal.",
        });
      }
      goal.maxRounds = maxRounds ?? goal.maxRounds;
      if (goal.round >= goal.maxRounds) {
        throw new PluginCliError(`The goal used all ${goal.maxRounds} rounds.`, {
          code: "round_limit",
          hint: `Pass --max-rounds <n> with n greater than ${goal.round}.`,
        });
      }
      goal.status = "active";
      goal.blocker = null;
      goal.note = null;
      goal.lastTurnSeq = (await latestTurn(threadId))?.seq ?? goal.lastTurnSeq;
      if (await canStartRound(threadId)) {
        goal.round += 1;
        await sendRound(threadId, goal);
        await save(threadId, goal);
        return `Goal resumed. Round ${goal.round} of ${goal.maxRounds} started.`;
      }
      await save(threadId, goal);
      return "Goal resumed. The next round starts when the current turn ends.";
    });
  }

  function refusal(error: unknown): never {
    if (error instanceof PluginCliError) {
      throw new experimental_PluginRpcRefusal({
        code: error.code === "goal_not_found" ? "not_found" : "conflict",
        message: error.message,
      });
    }
    throw error;
  }

  bb.rpc.register(rpcContract, {
    goal_get: async ({ threadId }) => (await load(threadId)) ?? null,
    goal_clear: ({ threadId }) =>
      locked(threadId, async () => ({ cleared: await clear(threadId) })),
    goal_pause: ({ threadId }) =>
      pauseGoal(threadId).then((message) => ({ message }), refusal),
    goal_resume: ({ threadId }) =>
      resumeGoal(threadId).then((message) => ({ message }), refusal),
  });

  const threadOption = {
    type: "string",
    description: "Thread id. Defaults to the thread that runs the command.",
    aliases: ["thread-id"],
  } as const;

  function targetThread(
    thread: string | undefined,
    ctx: PluginCliContext,
  ): string {
    const threadId = thread ?? ctx.threadId;
    if (threadId !== undefined) return threadId;
    throw new PluginCliError("No thread to act on.", {
      code: "missing_thread",
      hint: "Pass --thread <thread-id>.",
    });
  }

  bb.cli.register(
    defineCli({
      name: "goal",
      summary: "Inspect, pause, resume, or clear a thread's goal",
      commands: {
        status: cliCommand({
          summary: "Show the thread's goal",
          options: {
            thread: threadOption,
            json: { type: "boolean", description: "Print the goal as JSON" },
          },
          async run({ options }, ctx) {
            const threadId = targetThread(options.thread, ctx);
            const goal = await load(threadId);
            if (options.json) {
              return { exitCode: 0, stdout: JSON.stringify(goal ?? null) };
            }
            return {
              exitCode: 0,
              stdout:
                goal === undefined
                  ? `Thread ${threadId} has no goal.`
                  : describeGoal(goal),
            };
          },
        }),
        pause: cliCommand({
          summary:
            "Stop starting new rounds; the current turn finishes normally",
          options: { thread: threadOption },
          async run({ options }, ctx) {
            const threadId = targetThread(options.thread, ctx);
            return { exitCode: 0, stdout: await pauseGoal(threadId) };
          },
        }),
        resume: cliCommand({
          summary:
            "Make a paused, blocked, or round-limited goal active again",
          options: {
            thread: threadOption,
            "max-rounds": {
              type: "integer",
              min: 1,
              max: 100_000,
              description:
                "New round limit. Required when the goal used all its rounds.",
            },
          },
          async run({ options }, ctx) {
            const threadId = targetThread(options.thread, ctx);
            const message = await resumeGoal(threadId, options["max-rounds"]);
            return { exitCode: 0, stdout: message };
          },
        }),
        clear: cliCommand({
          summary: "Delete the thread's goal",
          options: { thread: threadOption },
          async run({ options }, ctx) {
            const threadId = targetThread(options.thread, ctx);
            return locked(threadId, async () => {
              await requireGoal(threadId);
              await clear(threadId);
              return { exitCode: 0, stdout: "Goal cleared." };
            });
          },
        }),
      },
    }),
  );

  // Idle events are not replayed while the plugin is unloaded. Catch up once:
  // continue or pause each active goal whose thread is idle now.
  void (async () => {
    for (const key of await bb.storage.kv.list("goal:")) {
      const threadId = key.slice("goal:".length);
      try {
        if ((await load(threadId))?.status !== "active") continue;
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.status === "idle") await continueGoal(threadId);
      } catch (error) {
        bb.log.warn(`startup check failed for ${threadId}: ${String(error)}`);
      }
    }
  })();
}
