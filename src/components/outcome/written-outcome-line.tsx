"use client";

import { AlertCircle, CheckCircle2, Info, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { WrittenOutcome } from "@/lib/outcome/written-outcome";

/**
 * The one mapping from a written outcome to how it looks.
 *
 * `CheckCircle2` and `text-success` appear on the `success` key and nowhere
 * else in this file, so no future edit can attach a tick to a run that wrote
 * nothing. Every import card and every provider-sync card renders its result
 * line through here; `src/__tests__/success-affordance-guard.test.ts` holds
 * that line.
 */
const OUTCOME_PRESENTATION: Record<
  WrittenOutcome,
  { Icon: LucideIcon; className: string }
> = {
  success: { Icon: CheckCircle2, className: "text-success" },
  partial: { Icon: TriangleAlert, className: "text-warning" },
  failed: { Icon: AlertCircle, className: "text-destructive" },
  empty: { Icon: Info, className: "text-muted-foreground" },
};

/**
 * The headline line of a write result. Sits inside the caller's existing
 * `aria-live` region where there is one, so the outcome is announced as it
 * lands; a `failed` or `partial` line carries `role="alert"` itself, because
 * a result that did not write is the case a user must not scroll past.
 */
export function WrittenOutcomeLine({
  outcome,
  message,
  testId,
}: {
  outcome: WrittenOutcome;
  message: string;
  testId: string;
}) {
  const { Icon, className } = OUTCOME_PRESENTATION[outcome];
  return (
    <p
      data-testid={testId}
      data-outcome={outcome}
      role={outcome === "failed" || outcome === "partial" ? "alert" : "status"}
      className="text-foreground flex items-start gap-2 text-xs"
    >
      <Icon
        className={`${className} mt-0.5 h-3.5 w-3.5 shrink-0`}
        aria-hidden="true"
      />
      <span>{message}</span>
    </p>
  );
}
