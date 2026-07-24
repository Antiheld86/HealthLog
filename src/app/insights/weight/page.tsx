"use client";

import Link from "next/link";
import { Scale } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { useChartDomainStats } from "@/hooks/use-chart-domain-stats";
import { Button } from "@/components/ui/button";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { SlugInsightStatusCard } from "@/components/insights/slug-insight-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricStatStrip } from "@/components/insights/metric-stat-strip";
import { CoachReadStrip } from "@/components/insights/derived/coach-read-strip";
import { MetricCorrelationCard } from "@/components/insights/metric-correlation-card";
import { MeasurementDiversityNudge } from "@/components/insights/measurement-diversity-nudge";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { buildWeightBandsFromHeight } from "@/lib/analytics/value-bands";

/**
 * v1.4.25 W4 — `/insights/weight`.
 *
 * Routed Weight sub-page. Renders the weight chart with the user's
 * height-derived green/orange/red bands plus the per-section AI
 * assessment. The chart-cog (`chartKey="weight"`) lets the user toggle
 * trend lines + comparison overlay independently from the dashboard
 * weight card.
 *
 * v1.4.28 R3d (BK-F-H1 + BK-F-M1) — analytics fetch + empty-state
 * branch now consume `useInsightsAnalytics()` + `<MetricEmptyState>`.
 */
export default function InsightsGewichtPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);
  const unitDisplay = useUnitDisplay();

  const { data: analytics, isEmpty } = useInsightsAnalytics("WEIGHT");
  const weightSummary = analytics?.summaries?.WEIGHT ?? null;

  // v1.32.26 — resolve the weight display unit + scale from the user's
  // preference (kg for metric, lb for imperial). This page inlines the shell
  // rather than riding the scaffold, so it converts the stat strip + chart
  // series + bands here. Weight has no affine offset, so the factor alone
  // covers both the values and the bands.
  const weightTransform = unitDisplay.transformFor("WEIGHT");
  const weightUnit = weightTransform.displayUnit;
  const weightScale = weightTransform.factor;
  const displaySummary =
    weightSummary && weightScale !== 1
      ? {
          ...weightSummary,
          min:
            weightSummary.min === null ? null : weightSummary.min * weightScale,
          max:
            weightSummary.max === null ? null : weightSummary.max * weightScale,
          mean:
            weightSummary.mean === null
              ? null
              : weightSummary.mean * weightScale,
          median:
            weightSummary.median === null
              ? null
              : weightSummary.median * weightScale,
        }
      : weightSummary;

  // v1.12.8 — visible-range stats shared between the chart and the strip.
  const { statsByType, onVisibleStats } = useChartDomainStats();

  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.weightSectionTitle")}
        description={t("insights.subPage.gewichtDescription")}
        explainerMetric="weight"
      >
        <MetricEmptyState
          icon={<Scale className="size-6" />}
          title={t("insights.emptyState.weight.title")}
          description={t("insights.emptyState.weight.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/measurements?add=WEIGHT">
                {t("insights.emptyState.weight.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I haven't recorded any weight yet — why does it matter, and what should I know before I start tracking?"
        />
      </SubPageShell>
    );
  }

  const weightBands = user?.heightCm
    ? buildWeightBandsFromHeight(user.heightCm, {
        lowerBound: 30,
        upperBound: 250,
      })
    : undefined;
  // The bands are kg bounds → scale into the display unit so the shaded zone
  // tracks the converted line (factor-only; weight carries no offset).
  const displayBands =
    weightBands && weightScale !== 1
      ? weightBands.map((band) => ({
          ...band,
          min: band.min * weightScale,
          max: band.max * weightScale,
        }))
      : weightBands;

  return (
    <SubPageShell
      title={t("insights.weightSectionTitle")}
      description={t("insights.subPage.gewichtDescription")}
      explainerMetric="weight"
      statStrip={
        <MetricStatStrip
          summary={displaySummary}
          unit={weightUnit}
          seriesLabel={t("insights.weightSectionTitle")}
          icon={Scale}
          windowStats={statsByType?.WEIGHT ?? null}
        />
      }
      coachReadStrip={<CoachReadStrip metricType="WEIGHT" unit={weightUnit} />}
      diversityNudge={
        <MeasurementDiversityNudge
          measurementType="WEIGHT"
          metricLabel={t("insights.weightSectionTitle")}
          timeZone={user?.timezone ?? undefined}
        />
      }
      coachLaunch
      captureType="WEIGHT"
      showAllValuesType="WEIGHT"
    >
      <HealthChartDynamic
        chartKey="weight"
        types={["WEIGHT"]}
        title={t("charts.weight")}
        titleIcon={Scale}
        colors={["var(--chart-1)"]}
        unit={weightUnit}
        valueBands={displayBands}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
        valueScale={weightScale}
        onVisibleStats={onVisibleStats}
      />

      <MetricTargetSummary slug="weight" />

      {/* v1.12.0 — Weight owns the weight × weekday correlation (relocated
          off the overview onto its metric page). */}
      <MetricCorrelationCard slug="weight" />

      <SlugInsightStatusCard
        slug="weight"
        icon={<Scale className="h-5 w-5" />}
      />
    </SubPageShell>
  );
}
