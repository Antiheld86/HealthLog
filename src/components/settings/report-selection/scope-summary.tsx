"use client";

/**
 * The one line that says what the artefact will contain.
 *
 * This is the consent check: reading it IS the review. Fenced inclusions are
 * restated by name rather than folded into the count, because a number cannot
 * be checked at a glance and "incl. Mood, PHQ-9" can.
 *
 * Meta tier — one sentence about the form beside it, not content.
 *
 * One per picker, so the test id ends with the same surface its picker does.
 */
import { scopeSummary } from "@/lib/report-selection/panel-state";
import type { ReportLeafId } from "@/lib/report-selection/catalogue";

import type { ReportScopeSurface } from "./surface";

export function ScopeSummary({
  t,
  surface,
  selected,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  surface: ReportScopeSurface;
  selected: ReadonlySet<ReportLeafId>;
}) {
  const summary = scopeSummary(selected);
  if (summary.total === 0) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-testid={`report-scope-summary-${surface}`}
      >
        {t("reportSelection.scopeNone")}
      </p>
    );
  }
  const base = t("reportSelection.scopeCount", {
    count: summary.total,
    groups: summary.groups,
  });
  const sensitive =
    summary.sensitiveLabelKeys.length > 0
      ? t("reportSelection.scopeSensitive", {
          names: summary.sensitiveLabelKeys.map((key) => t(key)).join(", "),
        })
      : null;
  return (
    <p
      className="text-muted-foreground text-xs"
      data-testid={`report-scope-summary-${surface}`}
    >
      {sensitive ? `${base} · ${sensitive}` : base}
    </p>
  );
}
