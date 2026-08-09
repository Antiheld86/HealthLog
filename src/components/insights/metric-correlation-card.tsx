"use client";

import { Spline } from "lucide-react";

import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useTranslations } from "@/lib/i18n/context";
import type {
  CorrelationKind,
  CorrelationResult,
} from "@/lib/insights/correlations";
import { CorrelationCard } from "@/components/insights/correlation-card";
import { SectionHeading } from "@/components/ui/section-heading";

/**
 * v1.12.0 — per-metric correlation card.
 *
 * The canonical home for the one cross-metric relationship a metric
 * owns (the iOS canonical template relocates correlations off the
 * overview onto the owning metric page):
 *
 *   • Weight page  → weight × weekday
 *   • Pulse page   → mood × pulse
 *
 * It reads the already-computed `correlations` block off the thick
 * `/api/analytics` slice — the same payload the Insights overview warms.
 * On the common path (user lands on the overview first) this is a free
 * cache read; on direct metric-page entry it pays one thick fetch, the
 * same trade-off `<MetricTargetSummary>` already makes for the targets
 * payload.
 *
 * Self-suppressing: renders nothing while the payload is in-flight, when
 * the correlations feature is off, or when the owned hypothesis is below
 * the statistical surfacing bar (`status !== "ok"`). The single
 * `<CorrelationCard>` carries its own scatter + interpretation + source.
 */

interface AnalyticsWithCorrelations {
  correlations?: Partial<Record<string, CorrelationResult>>;
}

/** Insights slug → the `correlations` payload key it owns. */
const SLUG_TO_CORRELATION: Record<string, string> = {
  weight: "weightWeekday",
  pulse: "moodPulse",
};

/** The `kind` the owned result must carry — guards a payload-key drift. */
const SLUG_TO_KIND: Record<string, CorrelationKind> = {
  weight: "weight-weekday",
  pulse: "mood-pulse",
};

interface MetricCorrelationCardProps {
  /** Insights category slug, e.g. `"weight"`. */
  slug: string;
}

export function MetricCorrelationCard({ slug }: MetricCorrelationCardProps) {
  const { t } = useTranslations();
  const flags = useFeatureFlags();
  const key = SLUG_TO_CORRELATION[slug];

  // Read the thick slice; correlations live only on the default payload.
  // The query is gated by the hook on `isAuthenticated`, and disabled
  // entirely when this slug owns no correlation so a target-less metric
  // never fires the thick fetch.
  const { data } = useAnalyticsQuery({
    enabled: key != null ? undefined : false,
  });
  const analytics = data as AnalyticsWithCorrelations | undefined;

  if (!flags.correlations || !key) return null;

  const result = analytics?.correlations?.[key];
  if (!result || result.status !== "ok") return null;
  // Guard against a payload-shape drift: only paint when the kind the
  // server returned matches the kind this slug claims to own.
  if (result.kind !== SLUG_TO_KIND[slug]) return null;

  return (
    <section
      data-slot="metric-correlation"
      data-correlation-slug={slug}
      aria-label={t("insights.correlationRow.title")}
      className="space-y-2"
    >
      <SectionHeading
        icon={Spline}
        title={t("insights.correlationRow.title")}
      />
      <CorrelationCard result={result} />
      {/* v1.18.6 (DISC-01) — the "observational, not causal / talk to your
          doctor" disclaimer is removed; the one-time onboarding acknowledgment
          now covers the not-medical-advice framing app-wide. */}
    </section>
  );
}
