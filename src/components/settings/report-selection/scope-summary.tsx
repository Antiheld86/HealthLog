"use client";

/**
 * The one line that says what the artefact will contain.
 *
 * This is the consent check: reading it IS the review. Fenced inclusions are
 * restated by name rather than folded into the count, because a number cannot
 * be checked at a glance and "incl. Mood, PHQ-9" can.
 *
 * Meta tier — one sentence about the form beside it, not content.
 */
import { scopeSummary } from "@/lib/report-selection/panel-state";
import type { ReportLeafId } from "@/lib/report-selection/catalogue";

export function ScopeSummary({
  t,
  selected,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  selected: ReadonlySet<ReportLeafId>;
}) {
  const summary = scopeSummary(selected);
  if (summary.total === 0) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-testid="report-scope-summary"
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
      data-testid="report-scope-summary"
    >
      {sensitive ? `${base} · ${sensitive}` : base}
    </p>
  );
}
