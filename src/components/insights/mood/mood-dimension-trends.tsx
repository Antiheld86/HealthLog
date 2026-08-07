"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useTranslations } from "@/lib/i18n/context";
import { MOOD_DIMENSIONS } from "@/lib/mood/dimensions";
import { cn } from "@/lib/utils";

/**
 * v1.37 — the five level-A dimensions over time.
 *
 * Each dimension is drawn in the orientation the person answered it in and
 * under the label they read, so a high stress line means a stressful stretch
 * rather than a good one. Nothing is flipped for the picture's convenience;
 * the legend says which way each scale runs.
 *
 * A dimension nobody has answered is not drawn and is named underneath as not
 * recorded. Drawing it flat through the middle would put five answers on the
 * chart for a question that was asked once.
 */

export interface MoodDimensionPointData {
  date: string;
  value: number;
  samples: number;
}

export interface MoodDimensionSummaryData {
  key: string;
  present: boolean;
  inverse: boolean;
  min: number;
  max: number;
  count: number;
  avg7: number | null;
  avg30: number | null;
  avg90: number | null;
  latest: number | null;
  latestDate: string | null;
  newestDaysAgo: number | null;
  series: MoodDimensionPointData[];
}

const WINDOWS = [7, 30, 90] as const;
type Window = (typeof WINDOWS)[number];

/** One colour per dimension, from the same semantic set the other charts use. */
const COLOR_BY_KEY: Record<string, string> = {
  a1: "var(--chart-1)",
  a2: "var(--destructive)",
  a3: "var(--dracula-orange)",
  a4: "var(--info)",
  a5: "var(--success)",
};

function meanForWindow(
  summary: MoodDimensionSummaryData,
  window: Window,
): number | null {
  if (window === 7) return summary.avg7;
  if (window === 30) return summary.avg30;
  return summary.avg90;
}

export function MoodDimensionTrends({
  dimensions,
}: {
  dimensions: MoodDimensionSummaryData[];
}) {
  const { t } = useTranslations();
  const [window, setWindow] = useState<Window>(30);

  const present = dimensions.filter((d) => d.present);
  const missing = dimensions.filter((d) => !d.present);

  const chartData = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    for (const summary of present) {
      for (const point of summary.series) {
        const row = byDate.get(point.date) ?? { date: point.date };
        row[summary.key] = point.value;
        byDate.set(point.date, row);
      }
    }
    const rows = [...byDate.values()].sort((a, b) =>
      String(a.date).localeCompare(String(b.date)),
    );
    // The series carry the longest window; the shorter ones are a slice of the
    // same points rather than a second read.
    return rows.slice(Math.max(0, rows.length - window));
  }, [present, window]);

  const labelFor = (key: string) => {
    const dimension = MOOD_DIMENSIONS.find((d) => d.key === key);
    return dimension ? t(dimension.labelKey) : key;
  };

  if (present.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("insights.mood.dimensions.none")}
      </p>
    );
  }

  return (
    <div className="space-y-3" data-slot="mood-dimension-trends">
      <div className="flex flex-wrap items-center gap-1.5">
        {WINDOWS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setWindow(option)}
            aria-pressed={window === option}
            className={cn(
              "min-h-9 rounded-full border px-3 text-xs transition-colors",
              window === option
                ? "border-primary bg-primary/15 text-primary"
                : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t("insights.mood.dimensions.window", { days: option })}
          </button>
        ))}
      </div>

      <div className="h-[clamp(160px,34vh,220px)] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 4, right: 8, bottom: 0, left: -20 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickFormatter={(value: string) => value.slice(5)}
              minTickGap={24}
            />
            <YAxis
              domain={[0, 10]}
              ticks={[0, 5, 10]}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            />
            <Tooltip
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                fontSize: "0.75rem",
              }}
              labelStyle={{ color: "var(--muted-foreground)" }}
              formatter={(value, name) => [
                String(value ?? ""),
                labelFor(String(name)),
              ]}
            />
            {present.map((summary) => (
              <Line
                key={summary.key}
                type="monotone"
                dataKey={summary.key}
                name={summary.key}
                stroke={COLOR_BY_KEY[summary.key] ?? "var(--chart-1)"}
                strokeWidth={2}
                dot={false}
                // A gap is a day nobody answered; joining across it would draw
                // a value that was never given.
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <ul className="space-y-1.5">
        {present.map((summary) => {
          const mean = meanForWindow(summary, window);
          const dimension = MOOD_DIMENSIONS.find((d) => d.key === summary.key);
          return (
            <li
              key={summary.key}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{
                    background: COLOR_BY_KEY[summary.key] ?? "var(--chart-1)",
                  }}
                />
                <span>{labelFor(summary.key)}</span>
                {summary.inverse && dimension ? (
                  <span className="text-muted-foreground text-xs">
                    {t("insights.mood.dimensions.higherIsMore", {
                      anchor: t(dimension.highAnchorKey),
                    })}
                  </span>
                ) : null}
              </span>
              <span className="text-foreground shrink-0 tabular-nums">
                {mean === null
                  ? t("insights.mood.dimensions.noneInWindow")
                  : mean}
              </span>
            </li>
          );
        })}
      </ul>

      {missing.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("insights.mood.dimensions.notRecorded", {
            list: missing.map((d) => labelFor(d.key)).join(", "),
          })}
        </p>
      ) : null}
    </div>
  );
}
