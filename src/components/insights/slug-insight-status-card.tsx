"use client";

import type { ReactNode } from "react";

import {
  useInsightStatus,
  type InsightStatusMetric,
} from "@/hooks/use-insight-status";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import type { CoachScopeSource } from "@/lib/ai/coach/types";

interface SlugInsightStatusCardProps {
  /** The bespoke metric slug the `/api/insights/<slug>-status` route keys on. */
  slug: InsightStatusMetric;
  /** The leading glyph (Scale, Smile, Pill, …). */
  icon: ReactNode;
}

/**
 * v1.25 — each bespoke slug maps to the Coach snapshot source it narrows the
 * hand-off to, plus the EXISTING localised metric-name key the auto-sent
 * preset interpolates. Resolving the label through `t()` keeps the opener in
 * the user's language (never a raw enum token), shared with the icon-only
 * Coach affordance the assessment card renders.
 */
const SLUG_COACH: Record<
  InsightStatusMetric,
  { source: CoachScopeSource; labelKey: string }
> = {
  "blood-pressure": {
    source: "bp",
    labelKey: "measurements.typeBloodPressure",
  },
  weight: { source: "weight", labelKey: "measurements.typeWeight" },
  pulse: { source: "pulse", labelKey: "measurements.typePulse" },
  bmi: { source: "bmi", labelKey: "measurements.typeBodyMassIndex" },
  mood: { source: "mood", labelKey: "insights.moodSectionTitle" },
  "medication-compliance": {
    source: "compliance",
    labelKey: "insights.medicationCompliance",
  },
};

/**
 * Shared mount for the bespoke per-metric assessment card.
 *
 * The five bespoke slug pages (`weight`, `bmi`, `pulse`, `blood-pressure`,
 * `mood`) each hand-wired the same eight-prop `<InsightStatusCard>` block off
 * `useInsightStatus(slug)`, with only the icon differing. This seam owns the
 * hook + the `status?.x ?? default` prop-defaulting so the title and every
 * field name live in one place — the sibling of `<MetricStatusCard>`, which
 * does the same for the generic `useInsightMetricStatus(metric)` route. Each
 * bespoke page drops ~9 lines and can no longer drift on a field name.
 */
export function SlugInsightStatusCard({
  slug,
  icon,
}: SlugInsightStatusCardProps) {
  const { t } = useTranslations();
  const mounted = useMounted();
  const { data: status, isLoading } = useInsightStatus(slug);

  const coach = SLUG_COACH[slug];

  return (
    <InsightStatusCard
      title={t("insights.assessmentTitle")}
      icon={icon}
      text={status?.text ?? null}
      hasProvider={status?.hasProvider ?? false}
      updatedAt={status?.updatedAt ?? null}
      assessment={status?.assessment}
      coachQuestion={t("insights.coach.assessmentPrompt", {
        metric: t(coach.labelKey),
      })}
      coachScope={{ metric: coach.source }}
      coachAutoSend
      // `!mounted ||` keeps the SSR pass and the hydration render on the
      // same skeleton branch. The status query is `enabled: isAuthenticated`,
      // and the auth query resolves from the early-hydrating shell — a
      // late-hydrating page boundary then saw `isLoading` flip true while
      // the server HTML carried the settled card (React #418).
      loading={!mounted || isLoading}
      preparing={status?.preparing ?? false}
    />
  );
}
