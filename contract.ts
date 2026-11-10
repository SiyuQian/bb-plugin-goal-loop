// Shared by server.ts and app.tsx: the stored goal and the RPC the composer
// card reads. The live query needs the contract value, not only its type.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Consecutive rounds that must report the same blocker before "blocked" is accepted. */
export const BLOCKED_AFTER_ROUNDS = 3;

export const goalSchema = z.object({
  objective: z.string(),
  status: z.enum(["active", "paused", "blocked", "complete", "budgetLimited"]),
  /** The round in progress. */
  round: z.number(),
  maxRounds: z.number(),
  /** The latest blocker report and its run of consecutive rounds. */
  blocker: z
    .object({
      key: z.string(),
      detail: z.string(),
      streak: z.number(),
      round: z.number(),
    })
    .nullable(),
  /** Completion evidence, or the reason the goal stopped. */
  note: z.string().nullable(),
  /** seq of the last turn/completed event the plugin acted on. */
  lastTurnSeq: z.number(),
});
export type Goal = z.infer<typeof goalSchema>;
export type GoalStatus = Goal["status"];

/** RPC tag of one thread's goal; the server invalidates it on every change. */
export const goalTag = (threadId: string) => `goal:${threadId}`;

const threadInput = z.object({ threadId: z.string().min(1) }).strict();

export const rpcContract = defineRpcContract({
  goal_get: {
    input: threadInput,
    output: goalSchema.nullable(),
    tags: ({ threadId }) => [goalTag(threadId)],
  },
  goal_clear: {
    input: threadInput,
    output: z.object({ cleared: z.boolean() }),
  },
  goal_pause: {
    input: threadInput,
    output: z.object({ message: z.string() }),
  },
  goal_resume: {
    input: threadInput,
    output: z.object({ message: z.string() }),
  },
});
