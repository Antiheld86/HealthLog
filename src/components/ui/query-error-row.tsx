"use client";

import type { ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * Read-failure row — the compact sibling of `<QueryErrorCard>`.
 *
 * Two dense metric surfaces (the HealthKit metric sub-pages and the vitals
 * dashboard) had each hand-rolled the identical row: a one-line message with
 * a Retry button on the same baseline. The tall centred card is the right
 * shape for a primary list surface, but on a strip of tiles it dominates the
 * geometry and pushes everything the user came for below the fold — so this
 * shape stays, promoted to a primitive instead of being copied a third time.
 *
 * Pick by surface (UI-STANDARDS §6):
 *  - primary / list surface → `QueryErrorCard`
 *  - dense metric strip or tile where the tall card would dominate →
 *    `QueryErrorRow`
 *  - chart body → `ChartErrorState`
 *
 * One deliberate change from the copies it replaces: the message renders in
 * `text-foreground`. An alert IS the content of a failed surface, and §3
 * reserves muted for meta — both copies had it muted.
 */
export function QueryErrorRow({
  message,
  onRetry,
  retryLabel,
  slot,
  retrySlot,
  className,
}: {
  /** The failure line. Defaults to the generic `common.loadFailed`. */
  message?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  /**
   * Overrides the row's `data-slot`. The two converted surfaces keep their
   * shipped hooks (`healthkit-metric-error`, `vitals-dashboard-error`) so
   * their tests and any e2e selector stay stable.
   */
  slot?: string;
  /** Same, for the Retry button's own `data-slot`. */
  retrySlot?: string;
  className?: string;
}) {
  const { t } = useTranslations();
  return (
    <div
      data-slot={slot ?? "query-error-row"}
      role="alert"
      className={cn(
        "bg-card border-border text-foreground flex flex-col items-start gap-3 rounded-xl border p-4 text-sm sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <span className="flex items-start gap-2 sm:items-center">
        <AlertTriangle
          className="text-muted-foreground mt-0.5 size-4 shrink-0 sm:mt-0"
          aria-hidden="true"
        />
        <span>{message ?? t("common.loadFailed")}</span>
      </span>
      {onRetry ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRetry}
          data-slot={retrySlot ?? "query-error-row-retry"}
          className="gap-1.5"
        >
          <RotateCw className="size-3.5" aria-hidden="true" />
          <span>{retryLabel ?? t("common.retry")}</span>
        </Button>
      ) : null}
    </div>
  );
}
