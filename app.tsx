// The goal card above a thread's composer, and the "Send as goal" row in the
// send button's menu. The card shows while the thread has a goal that is not
// complete, and refreshes when the server invalidates the goal's RPC tag.
import {
  definePluginApp,
  experimental_CollapsibleStackCard as CollapsibleStackCard,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useComposer,
  useRpc,
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

function GoalCard({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
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
  if (goal === undefined || goal === null || goal.status === "complete") {
    return null;
  }
  const toggle = goal.status === "active" ? pause : resume;
  const showToggle = goal.status !== "budgetLimited";
  // A blocker counts only while its run of rounds can still continue.
  const blocker =
    goal.blocker !== null && goal.blocker.round >= goal.round - 1
      ? goal.blocker
      : null;
  return (
    <CollapsibleStackCard
      label="Goal"
      title={`${TITLES[goal.status]} · round ${goal.round}/${goal.maxRounds}`}
      icon="Target"
      isActive={goal.status === "active"}
      dismiss={{
        label: "Clear goal",
        failureMessage: "Could not clear the goal.",
        onDismiss: async () => {
          await rpc.call("goal_clear", { threadId });
        },
      }}
    >
      <div className="space-y-1 px-3 py-2 text-sm">
        <p className="whitespace-pre-wrap">{goal.objective}</p>
        {blocker !== null && (
          <p className="text-muted-foreground">
            Blocker "{blocker.key}" ({blocker.streak}/{BLOCKED_AFTER_ROUNDS}{" "}
            rounds): {blocker.detail}
          </p>
        )}
        {goal.note !== null && (
          <p className="text-muted-foreground">{goal.note}</p>
        )}
        {showToggle && (
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
              disabled={toggle.isPending}
              onClick={() => {
                // On success the server refreshes the card; a failure shows below.
                toggle.mutate({ threadId }).catch(() => undefined);
              }}
            >
              {goal.status === "active" ? "Pause" : "Resume"}
            </button>
            {toggle.error !== null && (
              <span className="text-xs text-destructive">
                {toggle.error.message}
              </span>
            )}
          </div>
        )}
      </div>
    </CollapsibleStackCard>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "goal",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "goal", chrome: "bare", component: GoalBanner }],
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
