"use client";

import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";

import type { ComponentType } from "react";
import {
  BarChart3,
  Briefcase,
  CalendarDays,
  CalendarRange,
  Clock,
  Gauge,
  Grid3x3,
  Link2,
  Sparkles,
  Tag,
  Tags,
  TrendingUp,
} from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { MoodHeatmap } from "@/components/charts/mood-heatmap";
// v1.12.1 — the three Recharts mini-charts on this below-fold cluster are
// deferred via `next/dynamic`. The mood hero line chart above them is
// already dynamic on the page, so static-importing these pulled Recharts
// into the initial chunk for no first-paint benefit. Each loader paints a
// skeleton sized to the chart's own band so the deferred chunk arrives
// without a layout shift (charts stay Recharts, visually identical). Types
// stay value-free imports so they don't drag the chunk back in.
import type { MoodDistributionRow } from "./mood-distribution-chart";
import type { MoodDimensionSummaryData } from "./mood-dimension-trends";
import type { MoodWeekdayRow } from "./mood-weekday-chart";
import type { MoodTimeOfDayPattern } from "./mood-time-of-day-chart";
// v1.16.7 established the shared-barrel pattern for the trio; all three
// loaders now resolve the app-wide chart-runtime boundary, so they share
// the ONE recharts chunk with every other chart surface: the cards reveal
// together, and recharts ships exactly once for the whole app.
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
import type { ContextComparisonRow } from "@/lib/insights/mood-context-crosstab";
import { MoodTagBreakdown, type MoodTagRow } from "./mood-tag-breakdown";
import {
  MoodCorrelationCards,
  type MoodMetricCorrelationData,
} from "./mood-correlation-cards";
import {
  MoodStructuredTagBreakdown,
  type MoodStructuredTagRow,
} from "./mood-structured-tag-breakdown";
import { type MoodNarrativeItem } from "./mood-narrative-feed";
import { MoodWhatStandsOut } from "./mood-what-stands-out";
import { MoodInTargetTile } from "./mood-in-target-tile";
import {
  MoodStabilityTile,
  type MoodStabilityData,
} from "./mood-stability-tile";
import {
  MoodTagInfluence,
  type MoodTagInfluenceRow,
} from "./mood-tag-influence";
import { MoodBetterDays, type MoodBetterDayFactor } from "./mood-better-days";
import {
  MoodTagMetricCrosstab,
  type MoodTagMetricCrosstabRow,
} from "./mood-tag-metric-crosstab";
import {
  MoodFactorMetricCrosstab,
  type MoodFactorMetricCrosstabRow,
} from "./mood-factor-metric-crosstab";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * v1.8.5 — additional Mood Insights sections.
 *
 * Reads the pre-computed aggregate bundle from `/api/mood/insights`
 * (cheap cached server read, no LLM) and paints the heatmap,
 * distribution, weekday pattern, tag breakdown, and mood × metric
 * correlation cards. Renders nothing while loading / on error / on an
 * empty data set so the page degrades gracefully to the line chart.
 */

interface MoodInsightsResponse {
  summary: {
    totalEntries: number;
    inTargetPct: number | null;
  };
  heatmap: {
    windowDays: number;
    cells: Array<{ date: string; score: number; samples: number }>;
  };
  distribution: MoodDistributionRow[];
  // Optional only to tolerate a stale pre-v1.37 cached payload during a
  // rollout; the live endpoint always populates it.
  dimensions?: MoodDimensionSummaryData[];
  weekday: MoodWeekdayRow[];
  timeOfDay: MoodTimeOfDayPattern;
  stability: MoodStabilityData | null;
  tags: MoodTagRow[];
  structuredTags: MoodStructuredTagRow[];
  // Optional only to tolerate a stale pre-v1.11.5 cached payload during a
  // rollout; the live endpoint always populates both.
  tagInfluence?: {
    flat: MoodTagInfluenceRow[];
    structured: MoodTagInfluenceRow[];
  };
  betterDays?: MoodBetterDayFactor[];
  // Optional only to tolerate a stale pre-v1.12.0 cached payload during a
  // rollout; the live endpoint always populates it.
  tagMetricCrosstab?: MoodTagMetricCrosstabRow[];
  /** v1.38 — context value against the day's mood, counts included. */
  contextComparison?: ContextComparisonRow[];
  // Optional only to tolerate a stale pre-v1.14.0 cached payload during a
  // rollout; the live endpoint always populates it.
  factorCrosstab?: MoodFactorMetricCrosstabRow[];
  narratives: MoodNarrativeItem[];
  correlations: {
    sleep: MoodMetricCorrelationData;
    steps: MoodMetricCorrelationData;
    pulse: MoodMetricCorrelationData;
    weight: MoodMetricCorrelationData;
    bloodPressureSystolic: MoodMetricCorrelationData;
  };
}

function SectionCard({
  title,
  icon,
  children,
}: {
  title: string;
  // v1.12.6 — every mood section header now routes through `TileHeader`
  // (icon + white heading) so the subpage reads as one card language.
  icon: ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <TileHeader icon={icon} title={title} />
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * v1.12.7 — the mood spine is split into three render regions so the page can
 * thread the operator's exact top-to-bottom order without prop-drilling the
 * whole aggregate payload:
 *
 *   - "heatmap"    — the Stimmungskalender, lifted above the line chart.
 *   - "assessment" — the better-days Einschätzung, placed right after the
 *                    Ziel card.
 *   - "rest"       — the Einordnung classification tiles, the "what stands
 *                    out" card, and every deep-dive breakdown.
 *
 * All three regions read the SAME `queryKeys.moodInsights()` query, so
 * TanStack Query dedups the fetch (single network read, 60 s staleTime); the
 * regions are pure JSX slices of one resolved payload.
 */
export type MoodInsightsRegion = "heatmap" | "assessment" | "rest";

export function MoodInsightsSections({
  region = "rest",
}: {
  region?: MoodInsightsRegion;
} = {}) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.moodInsights(),
    queryFn: async () => {
      return apiGet<MoodInsightsResponse>("/api/mood/insights");
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });

  if (isLoading) {
    // Only the "rest" region carries the page-level loading skeleton; the
    // heatmap / assessment regions stay invisible while loading so they don't
    // stack three skeletons down the page.
    return region === "rest" ? (
      <Skeleton className="h-48 w-full rounded-lg" />
    ) : null;
  }

  if (!data || data.summary.totalEntries === 0) {
    return null;
  }

  const heatmapCells = Object.fromEntries(
    data.heatmap.cells.map((cell) => [cell.date, cell]),
  );

  const hasTags = data.tags.length > 0;
  const hasStructuredTags = data.structuredTags.length > 0;

  // The in-target tile is the canonical surface for the in-target share.
  // When it renders (inTargetPct present) drop the same-number `in-target`
  // takeaway from the feed so the percentage appears exactly once on the
  // page. The narrative still rides the API/LLM payload unchanged.
  const inTargetShown = data.summary.inTargetPct != null;
  const narratives = inTargetShown
    ? data.narratives.filter((item) => item.kind !== "in-target")
    : data.narratives;

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
  const betterDays = data.betterDays ?? [];
  const hasBetterDays = betterDays.length > 0;
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

  // v1.12.7 — the Stimmungskalender is lifted above the line chart on the page,
  // so it renders as its own region here.
  if (region === "heatmap") {
    return (
      <SectionCard title={t("insights.mood.heatmapTitle")} icon={CalendarDays}>
        <MoodHeatmap
          cells={heatmapCells}
          days={data.heatmap.windowDays}
          stretch
        />
      </SectionCard>
    );
  }

  // v1.12.7 — the better-days Einschätzung is placed right after the Ziel card
  // on the page, ahead of the classification tiles, so it renders as its own
  // region. It carries the same assessment-card weight the per-metric
  // `<InsightStatusCard>` uses on the other subpages (tighter `gap`/`py`, the
  // `insight-in` entry, and the `insight-assessment` hook) so it reads as THE
  // mood assessment, consistent across the app.
  if (region === "assessment") {
    if (!hasBetterDays) return null;
    return (
      <Card
        aria-live="polite"
        data-slot="insight-assessment"
        // v1.13.1 — match the canonical `gap-2` + `pb-1` heading-to-body
        // rhythm the other assessment cards use, so the heading sits tight
        // above its body instead of floating ~16-24 px above it.
        className="animate-insight-in gap-2 py-3 md:py-4"
      >
        <CardHeader>
          <TileHeader
            icon={Sparkles}
            title={t("insights.mood.betterDays.title")}
          />
        </CardHeader>
        <CardContent>
          <MoodBetterDays factors={betterDays} />
        </CardContent>
      </Card>
    );
  }

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
