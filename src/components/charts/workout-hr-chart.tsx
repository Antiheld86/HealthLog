"use client";

import { useMemo } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";

import { useTranslations } from "@/lib/i18n/context";
import {
  buildWorkoutHrChartData,
  workoutHrAxisDomain,
  type WorkoutHrCurvePoint,
} from "./workout-hr-chart-data";

/**
 * Per-workout heart-rate curve. Rendered ONLY through the shared
 * `chart-runtime.ts` barrel (the one recharts async boundary) so the
 * library stays a single shared chunk — never import this file directly
 * at a call site.
 *
 * `ComposedChart`: a range `Area` for the min→max envelope (drawn only
 * when the series is dense enough to be honest), a `Line` for the bucket
 * mean, optional %HRmax zone bands behind them, and dashed reference
 * lines at the session's average and peak. Gaps stay gaps (`connectNulls`
 * false) — a hole in the recording never reads as an interpolated
 * curve.
 */

export type WorkoutHrChartPoint = WorkoutHrCurvePoint;

export interface WorkoutHrZoneBand {
  zone: number;
  lowBpm: number | null;
  highBpm: number | null;
}

export interface WorkoutHrChartProps {
  points: WorkoutHrChartPoint[];
  bucketSec: number;
  /** Draw the min→max envelope band behind the mean line. */
  envelope: boolean;
  /** Workout average HR for the reference line. */
  avgHr: number | null;
  /** Workout peak HR for the reference line. */
  maxHr?: number | null;
  /** Optional %HRmax zone bands for the shaded background. */
  zones?: WorkoutHrZoneBand[] | null;
}

const ZONE_FILLS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function minuteTick(seconds: number): string {
  return String(Math.round(seconds / 60));
}

export function WorkoutHrChart({
  points,
  bucketSec,
  envelope,
  avgHr,
  maxHr,
  zones,
}: WorkoutHrChartProps) {
  const { t } = useTranslations();

  const data = useMemo(
    () => buildWorkoutHrChartData(points, bucketSec, envelope),
    [points, bucketSec, envelope],
  );
  const yDomain = useMemo(
    () => workoutHrAxisDomain(data, [avgHr, maxHr]),
    [data, avgHr, maxHr],
  );

  return (
    <div
      className="h-48 w-full touch-pan-y sm:h-64"
      data-slot="workout-hr-chart"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            opacity={0.5}
          />
          {zones?.map((z) =>
            z.lowBpm != null ? (
              <ReferenceArea
                key={z.zone}
                y1={z.lowBpm}
                y2={z.highBpm ?? undefined}
                fill={ZONE_FILLS[z.zone - 1]}
                fillOpacity={0.06}
                ifOverflow="hidden"
              />
            ) : null,
          )}
          <XAxis
            dataKey="tSec"
            type="number"
            domain={[0, "dataMax"]}
            tickFormatter={minuteTick}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            unit=""
          />
          <YAxis
            domain={yDomain ?? ["dataMin - 10", "dataMax + 10"]}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={44}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              fontSize: "0.875rem",
            }}
            labelFormatter={(tSec) =>
              `${minuteTick(Number(tSec))} ${t("insights.workouts.detail.hrAxisMinutes")}`
            }
            formatter={(value, name) => {
              if (name === "mean") {
                return [
                  `${value} bpm`,
                  t("insights.workouts.detail.hrChartTitle"),
                ];
              }
              // The envelope's own `[min, max]` pair, read back as the
              // spread inside that bucket rather than as a second series.
              if (name === "band" && Array.isArray(value)) {
                return [
                  t("insights.workouts.detail.hrRangeValue", {
                    low: String(value[0]),
                    high: String(value[1]),
                  }),
                  t("insights.workouts.detail.hrRangeLabel"),
                ];
              }
              return [null, null];
            }}
          />
          {/* Envelope band: one range `Area` over the bucket's own
              `[min, max]` pair. Deliberately not a stack — a stacked pair
              is measured from zero and drags the y-axis domain down with
              it, squashing the curve (see `workout-hr-chart-data.ts`). */}
          {envelope ? (
            <Area
              type="monotone"
              dataKey="band"
              stroke="none"
              fill="var(--chart-1)"
              fillOpacity={0.15}
              connectNulls={false}
              isAnimationActive={false}
            />
          ) : null}
          {avgHr != null ? (
            <ReferenceLine
              y={avgHr}
              stroke="var(--muted-foreground)"
              strokeDasharray="5 5"
              strokeOpacity={0.7}
              label={{
                value: t("insights.workouts.detail.hrAvgMarker", {
                  bpm: String(Math.round(avgHr)),
                }),
                position: "insideTopLeft",
                fill: "var(--muted-foreground)",
                fontSize: 11,
              }}
            />
          ) : null}
          {/* The session's peak, the second number the stats grid already
              names. Drawn so the curve can be read against it rather than
              leaving the reader to eyeball where the top was. */}
          {maxHr != null ? (
            <ReferenceLine
              y={maxHr}
              stroke="var(--chart-4)"
              strokeDasharray="4 4"
              strokeOpacity={0.6}
              label={{
                value: t("insights.workouts.detail.hrMaxMarker", {
                  bpm: String(Math.round(maxHr)),
                }),
                position: "insideBottomLeft",
                fill: "var(--muted-foreground)",
                fontSize: 11,
              }}
            />
          ) : null}
          <Line
            type="monotone"
            dataKey="mean"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
