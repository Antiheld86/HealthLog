"use client";

/**
 * The payload shape and the card frame both mood-insights modules need.
 *
 * Extracted when the breakdown cluster moved behind `next/dynamic`: the
 * eager module (heatmap + assessment) and the deferred one (every breakdown)
 * both describe the same `/api/mood/insights` response and both draw the same
 * card, and a second copy of either would be the drift this file exists to
 * prevent. Nothing heavy lives here — the type is erased at build time and the
 * frame is a `Card` with a `TileHeader` in it — so importing it from the eager
 * module costs the first-load graph nothing.
 */
import type { ComponentType } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";

import type { MoodDistributionRow } from "./mood-distribution-chart";
import type { MoodDimensionSummaryData } from "./mood-dimension-trends";
import type { MoodWeekdayRow } from "./mood-weekday-chart";
import type { MoodTimeOfDayPattern } from "./mood-time-of-day-chart";
import type { MoodTagRow } from "./mood-tag-breakdown";
import type { MoodMetricCorrelationData } from "./mood-correlation-cards";
import type { MoodStructuredTagRow } from "./mood-structured-tag-breakdown";
import type { MoodNarrativeItem } from "./mood-narrative-feed";
import type { MoodStabilityData } from "./mood-stability-tile";
import type { MoodTagInfluenceRow } from "./mood-tag-influence";
import type { MoodBetterDayFactor } from "./mood-better-days";
import type { MoodTagMetricCrosstabRow } from "./mood-tag-metric-crosstab";
import type { MoodFactorMetricCrosstabRow } from "./mood-factor-metric-crosstab";
import type { ContextComparisonRow } from "@/lib/insights/mood-context-crosstab";

export interface MoodInsightsResponse {
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

export function SectionCard({
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
