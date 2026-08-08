"use client";

/**
 * Every mood breakdown below the fold, in one deferred module.
 *
 * The classification tiles, the "what stands out" card, the four Recharts
 * mini-charts, both tag axes, the influence board, the two crosstabs, the
 * day-context comparison and the correlation cards. Between them they pull in
 * roughly a dozen card components and their icon sets, and none of it is
 * visible until the reader has scrolled past the calendar, the line chart, the
 * target card and the assessment.
 *
 * So it is a module rather than a section of its sibling, and its sibling
 * loads it through `next/dynamic` — the same treatment the insights mother
 * page gives its below-the-hero blocks. Splitting it out is what keeps the
 * eager graph for this route down to the calendar and the assessment: while
 * every one of these cards was a static import of `mood-insights-sections`,
 * fetching the page paid for all of them before painting anything.
 *
 * It takes the resolved payload as a prop instead of running its own query.
 * TanStack would have deduped a second read, but a prop means this module
 * cannot render a different snapshot of the same aggregate from the one the
 * regions above it drew.
 */
import {
  BarChart3,
  Briefcase,
  CalendarRange,
  Clock,
  Gauge,
  Grid3x3,
  Link2,
  Tag,
  Tags,
  TrendingUp,
} from "lucide-react";
import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

import { SectionCard, type MoodInsightsResponse } from "./mood-insights-shared";
// v1.12.1 — the four Recharts mini-charts here are deferred via
// `next/dynamic`. The mood hero line chart above them is already dynamic on
// the page, so static-importing these pulled Recharts into the initial chunk
// for no first-paint benefit. Each loader paints a skeleton sized to the
// chart's own band so the deferred chunk arrives without a layout shift
// (charts stay Recharts, visually identical).
//
// v1.16.7 established the shared-barrel pattern for the group; all four
// loaders resolve the app-wide chart-runtime boundary, so they share the ONE
// recharts chunk with every other chart surface: the cards reveal together,
// and recharts ships exactly once for the whole app.
const MoodDimensionTrends = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.MoodDimensionTrends,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-[clamp(160px,34vh,220px)] w-full rounded-md" />
    ),
  },
);
const MoodDistributionChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.MoodDistributionChart,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-[clamp(120px,26vh,150px)] w-full rounded-md" />
    ),
  },
);
const MoodWeekdayChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.MoodWeekdayChart,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-[clamp(120px,26vh,150px)] w-full rounded-md" />
    ),
  },
);
const MoodTimeOfDayChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.MoodTimeOfDayChart,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-[clamp(160px,38vh,220px)] w-full rounded-md" />
    ),
  },
);
import { MoodContextComparison } from "./mood-context-comparison";
import { MoodTagBreakdown } from "./mood-tag-breakdown";
import { MoodCorrelationCards } from "./mood-correlation-cards";
import { MoodStructuredTagBreakdown } from "./mood-structured-tag-breakdown";
import { MoodWhatStandsOut } from "./mood-what-stands-out";
import { MoodInTargetTile } from "./mood-in-target-tile";
import { MoodStabilityTile } from "./mood-stability-tile";
import { MoodTagInfluence } from "./mood-tag-influence";
import { MoodTagMetricCrosstab } from "./mood-tag-metric-crosstab";
import { MoodFactorMetricCrosstab } from "./mood-factor-metric-crosstab";

export function MoodInsightsBreakdowns({
  data,
}: {
  data: MoodInsightsResponse;
}) {
  const { t } = useTranslations();

  // The in-target tile is the canonical surface for the in-target share.
  // When it renders (inTargetPct present) drop the same-number `in-target`
  // takeaway from the feed so the percentage appears exactly once on the
  // page. The narrative still rides the API/LLM payload unchanged.
  const inTargetShown = data.summary.inTargetPct != null;
  const narratives = inTargetShown
    ? data.narratives.filter((item) => item.kind !== "in-target")
    : data.narratives;

  const hasTags = data.tags.length > 0;
  const hasStructuredTags = data.structuredTags.length > 0;
  const hasStabilityTile = data.stability != null;
  const hasInTargetTile = data.summary.inTargetPct != null;

  // F1 — fold the structured + flat influence axes into one list ranked by
  // absolute delta, so the strongest "this tag moves my mood" rows lead
  // regardless of which axis they came from. Defensive against a stale
  // server-cache payload minted before the v1.11.5 shape landed (the
  // aggregate is cached up to 60 s; a rollout can serve one old read).
  const influenceRows = [
    ...(data.tagInfluence?.structured ?? []),
    ...(data.tagInfluence?.flat ?? []),
  ].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const hasInfluence = influenceRows.length > 0;
  const crosstabRows = data.tagMetricCrosstab ?? [];
  const hasCrosstab = crosstabRows.length > 0;
  // Defensive against a stale server-cache payload minted before this shape
  // landed, the same way the influence rows above are.
  const contextRows = data.contextComparison ?? [];
  const hasContextComparison = contextRows.length > 0;
  const factorCrosstabRows = data.factorCrosstab ?? [];
  const hasFactorCrosstab = factorCrosstabRows.length > 0;
  const dimensionSummaries = data.dimensions ?? [];
  const hasDimensions = dimensionSummaries.some((d) => d.present);

  return (
    // v1.12.7 — "rest" region. The Stimmungskalender (now above the chart) and
    // the better-days Einschätzung (now right after the Ziel card) render in
    // their own regions above; this region carries the Einordnung classification
    // tiles (in-target share + stability band) FIRST, then the "what stands
    // out" card, then the descriptive breakdown sections. The classification
    // answers "where do I stand", and the rest is the supporting detail.
    <div className="space-y-4">
      {/* Einordnung — the classification tiles. */}
      {(hasInTargetTile || hasStabilityTile) && (
        // Two-up only when BOTH tiles render; a lone tile spans full width so
        // it never leaves a half-width orphan with dead space beside it.
        <div
          className={cn(
            "grid gap-4",
            hasInTargetTile && hasStabilityTile && "sm:grid-cols-2",
          )}
        >
          {hasInTargetTile && (
            <MoodInTargetTile pct={data.summary.inTargetPct} />
          )}
          {hasStabilityTile && <MoodStabilityTile stability={data.stability} />}
        </div>
      )}

      {/* v1.12.7 — the single "What stands out" card folds the narrative
          one-liners AND the FDR-controlled discovered relations into one tile
          (was two separate cards). Self-fetches the discovery surface and
          renders nothing when both halves are empty. */}
      <MoodWhatStandsOut narratives={narratives} />

      {/* v1.37 — the five level-A dimensions. Renders only once at least one
          of them carries a value; an account that has never opened the detail
          section sees the page it saw before. */}
      {hasDimensions && (
        <SectionCard title={t("insights.mood.dimensions.title")} icon={Gauge}>
          <MoodDimensionTrends dimensions={dimensionSummaries} />
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={t("insights.mood.distributionTitle")}
          icon={BarChart3}
        >
          <MoodDistributionChart distribution={data.distribution} />
        </SectionCard>
        <SectionCard
          title={t("insights.mood.weekdayTitle")}
          icon={CalendarRange}
        >
          <MoodWeekdayChart weekday={data.weekday} />
        </SectionCard>
      </div>

      {data.timeOfDay.reliable && (
        <SectionCard title={t("insights.mood.timeOfDay.title")} icon={Clock}>
          <MoodTimeOfDayChart pattern={data.timeOfDay} />
        </SectionCard>
      )}

      {hasStructuredTags && (
        <SectionCard title={t("insights.mood.structuredTagsTitle")} icon={Tags}>
          <MoodStructuredTagBreakdown tags={data.structuredTags} />
        </SectionCard>
      )}

      {hasTags && (
        <SectionCard title={t("insights.mood.tagsTitle")} icon={Tag}>
          <MoodTagBreakdown tags={data.tags} />
        </SectionCard>
      )}

      {hasInfluence && (
        <SectionCard
          title={t("insights.mood.influence.title")}
          icon={TrendingUp}
        >
          <MoodTagInfluence rows={influenceRows} />
        </SectionCard>
      )}

      {hasCrosstab && (
        <SectionCard title={t("insights.mood.crosstab.title")} icon={Grid3x3}>
          <MoodTagMetricCrosstab rows={crosstabRows} />
        </SectionCard>
      )}

      {hasContextComparison && (
        <SectionCard
          title={t("insights.mood.contextComparison.title")}
          icon={Briefcase}
        >
          <MoodContextComparison rows={contextRows} />
        </SectionCard>
      )}

      {hasFactorCrosstab && (
        <SectionCard
          title={t("insights.mood.factorCrosstab.title")}
          icon={Gauge}
        >
          <MoodFactorMetricCrosstab rows={factorCrosstabRows} />
        </SectionCard>
      )}

      <SectionCard title={t("insights.mood.correlationsTitle")} icon={Link2}>
        <p className="text-muted-foreground mb-2 text-sm">
          {t("insights.mood.correlationsDescription")}
        </p>
        <MoodCorrelationCards
          sleep={data.correlations.sleep}
          steps={data.correlations.steps}
          pulse={data.correlations.pulse}
          weight={data.correlations.weight}
          bloodPressureSystolic={data.correlations.bloodPressureSystolic}
        />
      </SectionCard>
    </div>
  );
}
