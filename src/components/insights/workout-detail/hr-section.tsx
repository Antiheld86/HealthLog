"use client";

import dynamic from "next/dynamic";
import { HeartPulse } from "lucide-react";
import type { ComponentProps } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";
import { useTranslations } from "@/lib/i18n/context";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";

// Route the HR curve through the ONE recharts async boundary so the
// library stays a single shared chunk (chart-runtime.ts header rule).
const WorkoutHrChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.WorkoutHrChart }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
function WorkoutHrChart(props: ComponentProps<typeof WorkoutHrChartLazy>) {
  return (
    <ChartErrorBoundary>
      <WorkoutHrChartLazy {...props} />
    </ChartErrorBoundary>
  );
}

export interface WorkoutDetailHrSectionProps {
  workout: WorkoutDetailPayload;
}

/**
 * Heart-rate curve card — mean line + optional min→max envelope + %HRmax
 * zone bands + average and peak reference lines. A muted provenance chip
 * discloses when the curve was reconstructed from pulse data around the
 * session rather than the workout's own sensor stream.
 *
 * Three states, and the middle one is the reason this is not a plain
 * hide-when-empty section:
 *
 *   - a curve, when the server resolved one;
 *   - a named absence, when the session HAS heart-rate figures (the
 *     stats grid is showing an average, a peak) but no reading-by-reading
 *     profile behind them. Silence there reads as "this page has no
 *     heart-rate section", which is wrong — the data exists, the shape of
 *     it does not, and saying so is the difference between an honest gap
 *     and an invisible one;
 *   - nothing at all, when the session carries no heart rate of any kind.
 *     There is no absence to report where nothing was ever measured, and
 *     an empty card would be a shell (page contract: hide, don't render
 *     empty).
 */
export function WorkoutDetailHrSection({
  workout,
}: WorkoutDetailHrSectionProps) {
  const { t } = useTranslations();
  const series = workout.hrSeries;
  const hasCurve = Boolean(series && series.points.length >= 2);
  const hasHeartRateAtAll =
    workout.avgHr != null || workout.maxHr != null || workout.minHr != null;

  if (!hasCurve && !hasHeartRateAtAll) return null;

  return (
    <Card data-slot="workout-detail-hr">
      <CardHeader className="gap-1">
        <TileHeader
          icon={HeartPulse}
          title={t("insights.workouts.detail.hrChartTitle")}
          titleAs="h2"
        />
        {hasCurve && series!.source === "pulse_window" ? (
          <p
            data-slot="workout-detail-hr-provenance"
            className="text-muted-foreground text-xs"
          >
            {t("insights.workouts.detail.hrFromPulse")}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {hasCurve ? (
          <WorkoutHrChart
            points={series!.points}
            bucketSec={series!.bucketSec}
            envelope={series!.envelope}
            avgHr={workout.avgHr}
            maxHr={workout.maxHr}
            zones={workout.zones?.zones ?? null}
          />
        ) : (
          <p
            data-slot="workout-detail-hr-empty"
            className="text-muted-foreground text-sm"
          >
            {t("insights.workouts.detail.hrNoProfile")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
