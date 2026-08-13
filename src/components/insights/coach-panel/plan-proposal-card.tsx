"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Target, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import {
  useCoachPlans,
  useCoachPlanMutations,
  type CoachPlanDTO,
} from "@/hooks/use-coach-plans";

/**
 * v1.27.x — the confirm cards for Coach plan proposals, rendered at the tail
 * of the open conversation's thread.
 *
 * The extractor (memory-refresh worker, runs AFTER the turn) writes a plan as
 * `status: "proposed"`; nothing becomes a standing plan until the user
 * confirms it here (or on `/coach/plans`). Because the proposal lands
 * asynchronously, the block slow-polls the proposed list while the thread is
 * mounted (TanStack pauses the interval in background tabs) and only shows
 * proposals whose `sourceConversationId` is the OPEN conversation — a
 * proposal born in an older thread stays on the management page instead of
 * popping into an unrelated chat.
 *
 * Accept → PATCH `{status:"active"}` (the plan enters the Coach's snapshot
 * memory block from the next turn on). Decline → DELETE (soft-delete; the
 * proposal never activates and stops counting against the per-user cap).
 * A settled card collapses to a one-line confirmation for the session so the
 * refetch dropping the row from the proposed list cannot double-prompt.
 */

/** Slow poll (ms) — proposals arrive via the post-turn background worker. */
export const PROPOSAL_POLL_MS = 20_000;

/**
 * Attempt ceiling for the proposal poll. The extractor runs right after the
 * turn and lands its proposal within a couple of minutes; 15 polls (~5 min
 * of coverage) catch it with margin, and every settled response counts an
 * attempt. Without the cap an open thread polled the proposed list every
 * 20 s indefinitely. Same bounded-poll shape as `nextAdvisorPollInterval`
 * (`use-insights-advisor.ts`); a new turn's invalidation bumps the query and
 * the next mount of a fresh conversation restarts the budget.
 */
export const PROPOSAL_POLL_MAX_ATTEMPTS = 15;

/**
 * Decide whether the proposal query schedules its next poll. Pure so the
 * ceiling is unit-testable: returns the slow interval until the attempt cap
 * is reached, then `false` (poll off).
 */
export function nextProposalPollInterval(
  dataUpdateCount: number,
): number | false {
  if (dataUpdateCount >= PROPOSAL_POLL_MAX_ATTEMPTS) return false;
  return PROPOSAL_POLL_MS;
}

type SettledOutcome = "accepted" | "declined";

export function PlanProposalCards({
  conversationId,
}: {
  conversationId: string;
}) {
  const { t } = useTranslations();
  const [settled, setSettled] = useState<
    Array<{ id: string; outcome: SettledOutcome }>
  >([]);

  const query = useCoachPlans({
    filter: { status: "proposed" },
    refetchInterval: (q) => nextProposalPollInterval(q.state.dataUpdateCount),
  });

  // Quiet on error by design: the thread is the Coach's surface, and a failed
  // enhancement read must never interrupt the conversation with an error card.
  const proposals = (query.data ?? []).filter(
    (p) =>
      p.sourceConversationId === conversationId &&
      p.ifCue !== null &&
      p.thenAction !== null &&
      !settled.some((s) => s.id === p.id),
  );

  if (proposals.length === 0 && settled.length === 0) return null;

  return (
    <div data-slot="coach-plan-proposals" className="flex flex-col gap-2.5">
      {proposals.map((plan) => (
        <PlanProposalCard
          key={plan.id}
          plan={plan}
          onSettled={(outcome) =>
            setSettled((prev) => [...prev, { id: plan.id, outcome }])
          }
        />
      ))}
      {settled.map((s) => (
        <p
          key={s.id}
          role="status"
          data-slot="coach-plan-proposal-done"
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
        >
          <Check className="text-success size-3.5" aria-hidden="true" />
          {t(
            s.outcome === "accepted"
              ? "coach.plans.accepted"
              : "coach.plans.declined",
          )}
        </p>
      ))}
    </div>
  );
}

/** One proposal with confirm / decline actions. */
function PlanProposalCard({
  plan,
  onSettled,
}: {
  plan: CoachPlanDTO;
  onSettled: (outcome: SettledOutcome) => void;
}) {
  const { t } = useTranslations();
  const { setStatus, remove } = useCoachPlanMutations();
  const busy = setStatus.isPending || remove.isPending;

  return (
    <div
      data-slot="coach-plan-proposal-card"
      className={cn(
        "border-border/60 bg-muted/40 flex flex-col gap-2.5 rounded-xl border",
        "px-3.5 py-3 text-sm",
      )}
    >
      <div className="flex items-start gap-2">
        <div
          aria-hidden="true"
          className="bg-primary/10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full"
        >
          <Target className="text-primary size-3.5" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-muted-foreground text-xs font-medium">
            {t("coach.plans.proposalTitle")}
          </span>
          {/* The plan prose is the user's own committed intention — content,
              never meta, so it reads in foreground per the text-colour rules. */}
          <span className="text-foreground leading-relaxed break-words">
            {t("coach.plans.ifThen", {
              cue: plan.ifCue ?? "",
              action: plan.thenAction ?? "",
            })}
          </span>
          {plan.target ? (
            <span className="text-foreground text-xs break-words">
              {t("coach.plans.targetPrefix", { target: plan.target })}
            </span>
          ) : null}
          <span className="text-muted-foreground text-xs uppercase">
            {plan.metric}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-slot="coach-plan-proposal-accept"
          onClick={() =>
            setStatus.mutate(
              { id: plan.id, status: "active" },
              {
                onSuccess: () => onSettled("accepted"),
                onError: () => toast.error(t("coach.plans.failed")),
              },
            )
          }
          disabled={busy}
          className={cn(
            "bg-primary/90 text-primary-foreground hover:bg-primary",
            "focus-visible:ring-ring/50 inline-flex min-h-9 items-center gap-1.5",
            "rounded-md px-3 py-1.5 text-xs font-medium outline-none",
            "focus-visible:ring-2 disabled:opacity-50",
          )}
        >
          {busy && setStatus.isPending ? (
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Check className="size-3.5" aria-hidden="true" />
          )}
          {t("coach.plans.accept")}
        </button>
        <button
          type="button"
          data-slot="coach-plan-proposal-decline"
          onClick={() =>
            remove.mutate(plan.id, {
              onSuccess: () => onSettled("declined"),
              onError: () => toast.error(t("coach.plans.failed")),
            })
          }
          disabled={busy}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:opacity-50"
        >
          <X className="size-3.5" aria-hidden="true" />
          {t("coach.plans.decline")}
        </button>
      </div>
    </div>
  );
}
