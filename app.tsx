// The goal bar above a thread's composer, and the "Send as goal" row in the
// send button's menu. The bar shows the status, round, objective, Pause or
// Resume, and Clear while the thread has a goal that is not complete. It
// refreshes when the server invalidates the goal's RPC tag.
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useComposer,
} from "@get-bb/plugin-sdk/app";
import {
  BLOCKED_AFTER_ROUNDS,
  rpcContract,
  type GoalStatus,
} from "./contract.ts";

const TITLES: Record<GoalStatus, string> = {
  active: "Goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  budgetLimited: "Goal out of rounds",
  complete: "Goal complete",
};

function GoalBanner() {
  const { scope } = useComposer();
  return scope.kind === "thread" ? (
    <GoalCard threadId={scope.threadId} />
  ) : null;
}

// Mirrors the header of bb's stack card (experimental_CollapsibleStackCard),
// which has no slot for the Pause and Resume button.
const BAR_BUTTON =
  "flex min-h-8 shrink-0 cursor-pointer items-center justify-center border-l border-border/35 bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:text-muted-foreground/60";

function GoalCard({ threadId }: { threadId: string }) {
  const { data: goal } = useRpcQuery({
    contract: rpcContract,
    method: "goal_get",
    input: { threadId },
  });
  const pause = useRpcMutation({ contract: rpcContract, method: "goal_pause" });
  const resume = useRpcMutation({
    contract: rpcContract,
    method: "goal_resume",
  });
  const clear = useRpcMutation({ contract: rpcContract, method: "goal_clear" });
  if (goal === undefined || goal === null || goal.status === "complete") {
    return null;
  }
  const isActive = goal.status === "active";
  const toggle = isActive ? pause : resume;
  const showToggle = goal.status !== "budgetLimited";
  // A blocker counts only while its run of rounds can still continue.
  const blocker =
    goal.blocker !== null && goal.blocker.round >= goal.round - 1
      ? goal.blocker
      : null;
  const error = toggle.error ?? clear.error;
  // On success the server refreshes the bar; a failure shows below the bar.
  const run = (mutation: {
    mutate(input: { threadId: string }): Promise<unknown>;
  }) => {
    mutation.mutate({ threadId }).catch(() => undefined);
  };
  return (
    <div className="text-xs">
      <div
        role="group"
        aria-label="Goal"
        className="flex min-h-8 w-full items-stretch"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5">
          <Icon
            name="Target"
            aria-hidden
            className={`size-3.5 shrink-0 ${isActive ? "animate-shine-icon text-foreground" : "text-muted-foreground/45"}`}
          />
          <span
            className={`shrink-0 whitespace-nowrap ${isActive ? "animate-shine font-medium text-foreground" : "text-muted-foreground"}`}
          >
            {TITLES[goal.status]} · round {goal.round}/{goal.maxRounds}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-foreground"
            title={goal.objective}
          >
            {goal.objective}
          </span>
        </div>
        {showToggle && (
          <button
            type="button"
            aria-label={isActive ? "Pause goal" : "Resume goal"}
            title={isActive ? "Pause" : "Resume"}
            className={`${BAR_BUTTON} w-8`}
            disabled={toggle.isPending}
            onClick={() => run(toggle)}
          >
            <Icon
              name={isActive ? "Pause" : "Play"}
              aria-hidden
              className="size-3.5"
            />
          </button>
        )}
        <button
          type="button"
          aria-label="Clear goal"
          title="Clear goal"
          className={`${BAR_BUTTON} w-8`}
          disabled={clear.isPending}
          onClick={() => run(clear)}
        >
          <Icon
            name={clear.isPending ? "Loading" : "X"}
            aria-hidden
            className={`size-3.5 ${clear.isPending ? "animate-spin" : ""}`}
          />
        </button>
      </div>
      {(blocker !== null || goal.note !== null || error !== null) && (
        <div className="space-y-0.5 border-t border-border/35 px-3 py-1.5 text-muted-foreground">
          {blocker !== null && (
            <p>
              Blocker "{blocker.key}" ({blocker.streak}/{BLOCKED_AFTER_ROUNDS}{" "}
              rounds): {blocker.detail}
            </p>
          )}
          {goal.note !== null && <p>{goal.note}</p>}
          {error !== null && <p className="text-destructive">{error.message}</p>}
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "goal",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "goal", component: GoalBanner }],
    sendMenu: [
      {
        id: "send-as-goal",
        label: "Send as goal",
        icon: "Target",
        description:
          "Send this message, then keep the agent working on it until it is done.",
        disabled: (composer) =>
          composer.text.trim() === "" || composer.isSubmittingBlocked,
        // The server's message.dispatch hook sees this submission and starts the goal.
        run: ({ composer }) =>
          composer
            .submit({
              experimental_mode: "queue-if-active",
              experimental_data: { goal: true },
            })
            // bb already showed a toast and restored the draft. A rejection
            // here adds a second "Plugin action failed" toast.
            .catch(() => undefined),
      },
    ],
  });
});
