"use client";

import { useState, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations } from "@/lib/i18n/context";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { resolveIntlLocale } from "@/lib/format-locale";
import type { Locale } from "@/lib/i18n/config";

/**
 * v1.4.25 W4c → W3f — sleep-stage composition chart.
 *
 * The maintainer directive 2026-05-14: switch from "30-day average composition"
 * to a per-night stacked column chart so the user sees nightly stage
 * variation, not just a rolling average. Apple Health's sleep tab is
 * the visual reference — one column per night, stacks for REM / Deep /
 * Core / Awake.
 *
 * Window toggle: 7 / 14 / 30 days, default 7. The toggle pill above
 * the chart matches the per-chart cog pattern in the rest of the app.
 * Backed by `/api/analytics`'s `sleepStages.perNight` field (added in
 * v1.4.25 W3f); the parent threads the full per-night array and the
 * chart slices it down to the active window.
 *
 * Accessibility: the Recharts wrapper sets `role="img"` and an
 * `aria-label` derived from the composition so screen readers hear a
 * meaningful summary instead of a forest of `<rect>` elements.
 */

export interface SleepStageNight {
  /** Berlin-tz day key (YYYY-MM-DD). */
  dayKey: string;
  /** Per-stage minutes of the MAIN night. Naps are not in here. */
  stages: Record<string, number>;
  /**
   * Time asleep across this day's naps, in minutes. Absent on a day with no
   * nap, which is most days — the chart draws nothing for it and the legend
   * does not carry a nap entry.
   */
  napMinutes?: number;
  /** How many naps that is. Absent alongside `napMinutes`. */
  napCount?: number;
}

export interface SleepStageBreakdown {
  windowDays: number;
  nights: number;
  totalMinutes: number;
  /**
   * Keys mirror the Prisma `SleepStage` enum:
   *   IN_BED, AWAKE, ASLEEP, REM, CORE, DEEP.
   * Values are total minutes across the trailing-30 window.
   */
  stages: Record<string, number>;
  /**
   * v1.4.25 W3f — per-night breakdown over the trailing 30 days,
   * sorted ascending. The chart slices the trailing N entries based on
   * the active window toggle.
   */
  perNight?: SleepStageNight[];
}

export interface SleepStageStackedBarProps {
  breakdown: SleepStageBreakdown;
}

/** Window toggle values. Default 7. */
const WINDOW_DAYS = [7, 14, 30] as const;
type WindowSize = (typeof WINDOW_DAYS)[number];

/**
 * Order on the stack — deepest restorative stages first so a user
 * scanning left → right reads quality before context.
 *
 * IN_BED is deliberately NOT a stack segment. It is the TOTAL time in
 * bed (≈ CORE + DEEP + REM + AWAKE), so stacking it on top of those
 * phases doubled every bar (~14 h for a 7 h night) and inflated the
 * tooltip's per-night total. With it out of the stack the bar height
 * and the tooltip total are the real night. The `STAGE_COLORS.IN_BED`
 * token + the `insights.sleep.stages.inBed` label survive for the
 * last-night hypnogram, which still renders the in-bed span.
 */
export const STAGE_ORDER = ["DEEP", "REM", "CORE", "ASLEEP", "AWAKE"] as const;

/**
 * The nap band. Not a sleep stage — it is the day's daytime sleep, kept out
 * of the night's stage buckets and drawn as its own block on top of the
 * column so the night below it reads as the night.
 *
 * The band is only rendered when the visible window actually holds a nap. On
 * a week without one there is no bar, no legend entry, and no tooltip row.
 */
const NAP_KEY = "NAP";

/**
 * Dracula stage palette. Exported so the last-night hypnogram
 * (`sleep-hypnogram.tsx`) reuses the exact same tokens — per the
 * charts-visual-identity rule, no token reshuffle.
 */
export const STAGE_COLORS: Record<string, string> = {
  DEEP: "var(--chart-1)", // dracula-purple — deepest, most restorative
  REM: "var(--chart-3)", // dracula-pink — dream phase
  CORE: "var(--info)", // dracula-cyan — bulk of sleep
  ASLEEP: "var(--success)", // dracula-green — legacy iOS 15- unspecified
  AWAKE: "var(--dracula-yellow)", // dracula-yellow — wake bouts
  IN_BED: "var(--chart-inbed)", // muted blue-grey — pre-asleep
  [NAP_KEY]: "var(--dracula-orange)", // daytime sleep, not a night stage
};

/**
 * Format a Berlin-tz day key (YYYY-MM-DD) as a short x-axis tick.
 * 7-day window → "Mon" / "Tue" / …; 14-day → "M 10" / "T 11" / …;
 * 30-day → "May 10" / "May 11" / …  Recharts handles overflow via
 * interval=preserveStartEnd so we keep the label space tight without
 * forced rotation.
 *
 * The constructed Date is anchored to UTC so the rendered tick is
 * stable regardless of the SSR server's local timezone — without the
 * anchor a user in Asia/Tokyo viewing a server rendered in
 * Europe/Berlin could see the weekday tick shift by one. We pair the
 * UTC anchor with `timeZone: "UTC"` on the locale formatter so both
 * sides of the conversion agree.
 */
function formatDayTick(
  dayKey: string,
  window: WindowSize,
  locale: Locale,
): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (window === 7) {
    return date.toLocaleDateString(resolveIntlLocale(locale), {
      timeZone: "UTC",
      weekday: "short",
    });
  }
  if (window === 14) {
    return `${date.getUTCDate()}.`;
  }
  return date.toLocaleDateString(resolveIntlLocale(locale), {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

export function SleepStageStackedBar({ breakdown }: SleepStageStackedBarProps) {
  const { t, locale } = useTranslations();

  // v1.4.25 W3f — window toggle (7 / 14 / 30). Default 7d so the user
  // sees their most recent week with maximal per-bar resolution.
  const [windowDays, setWindowDays] = useState<WindowSize>(7);

  // Pull stage names from i18n once so the legend + tooltip share a
  // single source of truth.
  const stageLabels: Record<string, string> = {
    DEEP: t("insights.sleep.stages.deep"),
    REM: t("insights.sleep.stages.rem"),
    CORE: t("insights.sleep.stages.core"),
    ASLEEP: t("insights.sleep.stages.asleep"),
    AWAKE: t("insights.sleep.stages.awake"),
    IN_BED: t("insights.sleep.stages.inBed"),
    [NAP_KEY]: t("insights.sleep.stages.nap"),
  };

  // v1.4.25 W3f — per-night dataset. Slice the trailing N nights and
  // build a Recharts row per night with one numeric key per stage.
  // Empty perNight (legacy clients during the rollout) falls back to
  // the aggregate row so the chart still renders something rather
  // than going blank.
  const data = useMemo(() => {
    const perNight = breakdown.perNight ?? [];
    if (perNight.length === 0) {
      // Legacy fallback: render the 30-day aggregate as a single row
      // so the chart degrades gracefully against a pre-W3f payload.
      const fallbackRow: Record<string, number | string> = {
        dayKey: "aggregate",
        label: t("insights.sleep.compositionTitle"),
      };
      for (const stage of STAGE_ORDER) {
        fallbackRow[stage] = breakdown.stages[stage] ?? 0;
      }
      return [fallbackRow];
    }
    const trailing = perNight.slice(-windowDays);
    return trailing.map((night) => {
      const row: Record<string, number | string> = {
        dayKey: night.dayKey,
        label: formatDayTick(night.dayKey, windowDays, locale),
      };
      for (const stage of STAGE_ORDER) {
        row[stage] = night.stages[stage] ?? 0;
      }
      // A day without a nap carries a plain 0 here, which Recharts draws as
      // nothing; the band itself is only mounted when some day in the window
      // has one, so the legend stays clean on a nap-less week.
      row[NAP_KEY] = night.napMinutes ?? 0;
      row.napCount = night.napCount ?? 0;
      return row;
    });
  }, [breakdown, windowDays, locale, t]);

  // Mount the nap band only when the VISIBLE window holds one.
  const hasNap = useMemo(
    () =>
      data.some(
        (row) =>
          typeof row[NAP_KEY] === "number" && (row[NAP_KEY] as number) > 0,
      ),
    [data],
  );

  // Empty-state guard — no perNight rows AND no aggregate.
  const hasData =
    data.length > 0 &&
    data.some((row) =>
      STAGE_ORDER.some(
        (stage) => typeof row[stage] === "number" && (row[stage] as number) > 0,
      ),
    );

  const ariaLabel = t("insights.sleep.compositionAriaLabel", {
    nights: breakdown.nights,
  });

  return (
    <Card data-slot="sleep-stage-stacked-bar">
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            {/* The canonical tile header — the title used to be a bare
                `CardTitle` in a hand-rolled row. The window toggles stay a
                sibling of the title+subtitle pair rather than riding the
                header's `right` slot: the subtitle belongs under the title,
                and the toggles need to drop to their own row below `sm`
                (the sanctioned inline-action-row shape). */}
            <TileHeader title={t("insights.sleep.compositionTitle")} />
            <span className="text-muted-foreground text-xs">
              {t("insights.sleep.compositionSubtitle", {
                nights: breakdown.nights,
              })}
            </span>
          </div>
          <div
            // v1.4.27 MB7 / CF-70 — bump the gap from `gap-1` to
            // `gap-1.5` so the three window-toggle buttons (7d /
            // 14d / 30d) breathe enough on Pixel 5 that the active
            // pill's border doesn't fuse with the inactive neighbour.
            className="flex items-center gap-1.5 self-end sm:self-auto"
            data-slot="sleep-stage-window-toggle"
          >
            {WINDOW_DAYS.map((w) => (
              <Button
                key={w}
                type="button"
                variant={windowDays === w ? "default" : "ghost"}
                size="sm"
                className="min-h-11 px-2 text-xs sm:px-3"
                onClick={() => setWindowDays(w)}
                aria-pressed={windowDays === w}
                data-slot={`sleep-stage-window-${w}`}
              >
                {w}d
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p
            className="text-muted-foreground py-8 text-center text-xs"
            data-slot="sleep-stage-empty"
          >
            {t("insights.sleep.stages.unavailable")}
          </p>
        ) : (
          <div role="img" aria-label={ariaLabel}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={data}
                margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  opacity={0.3}
                />
                <XAxis
                  type="category"
                  dataKey="label"
                  stroke="var(--muted-foreground)"
                  fontSize={10}
                  interval="preserveStartEnd"
                />
                <YAxis
                  type="number"
                  stroke="var(--muted-foreground)"
                  fontSize={11}
                  tickFormatter={(v: number) => {
                    // Render the y-axis as hours so 480 min reads as 8h.
                    if (v <= 0) return "0";
                    return `${Math.round(v / 60)}h`;
                  }}
                />
                <Tooltip
                  cursor={{ fill: "transparent" }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0)
                      return null;
                    const row = payload[0]?.payload as
                      Record<string, number | string> | undefined;
                    const napCount =
                      typeof row?.napCount === "number" ? row.napCount : 0;
                    // The footer total is the NIGHT. The nap is listed above
                    // it as its own line and stays out of the sum, so the
                    // per-stage percentages keep meaning "of this night".
                    const totalNight = payload.reduce(
                      (sum, entry) =>
                        entry.dataKey === NAP_KEY
                          ? sum
                          : sum +
                            (typeof entry.value === "number" ? entry.value : 0),
                      0,
                    );
                    return (
                      <div className="bg-popover text-popover-foreground rounded-md border p-2 text-xs shadow-md">
                        <div className="border-border mb-1 border-b pb-1 font-medium">
                          {label}
                        </div>
                        {payload.map((entry) => {
                          const stage = String(entry.dataKey ?? "");
                          const minutes =
                            typeof entry.value === "number" ? entry.value : 0;
                          if (minutes === 0) return null;
                          const isNap = stage === NAP_KEY;
                          const label = isNap
                            ? napCount > 1
                              ? t("insights.sleep.stages.napCount", {
                                  count: String(napCount),
                                })
                              : stageLabels[NAP_KEY]
                            : (stageLabels[stage] ?? stage);
                          const pct =
                            totalNight > 0
                              ? Math.round((minutes / totalNight) * 100)
                              : 0;
                          return (
                            <div
                              key={stage}
                              className="flex items-center justify-between gap-3"
                            >
                              <span className="flex items-center gap-1.5">
                                <span
                                  aria-hidden="true"
                                  className="inline-block h-2 w-2 rounded-sm"
                                  style={{ background: STAGE_COLORS[stage] }}
                                />
                                {label}
                              </span>
                              <span className="text-muted-foreground">
                                {/* The nap is not part of the night, so it
                                    gets no share-of-night percentage. */}
                                {isNap
                                  ? formatDurationMinutes(minutes, t)
                                  : `${formatDurationMinutes(minutes, t)} · ${pct}%`}
                              </span>
                            </div>
                          );
                        })}
                        {totalNight > 0 && (
                          <div className="border-border mt-1 flex items-center justify-between gap-3 border-t pt-1 font-medium">
                            <span>{t("insights.sleep.headlineTitle")}</span>
                            <span>{formatDurationMinutes(totalNight, t)}</span>
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11 }}
                  formatter={(value: string) => stageLabels[value] ?? value}
                />
                {STAGE_ORDER.map((stage) => (
                  <Bar
                    key={stage}
                    dataKey={stage}
                    stackId="stages"
                    fill={STAGE_COLORS[stage]}
                    isAnimationActive={false}
                  >
                    <Cell fill={STAGE_COLORS[stage]} />
                  </Bar>
                ))}
                {hasNap && (
                  <Bar
                    key={NAP_KEY}
                    dataKey={NAP_KEY}
                    stackId="stages"
                    fill={STAGE_COLORS[NAP_KEY]}
                    isAnimationActive={false}
                  >
                    <Cell fill={STAGE_COLORS[NAP_KEY]} />
                  </Bar>
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
