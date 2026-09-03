/**
 * Range-display helpers for the dashboard tile strip and chart grid:
 * traffic-light colour classes, the colour-legend hint block, the
 * minutes→hours sleep projection, and the timezone-aware greeting hour.
 *
 * Extracted from the dashboard page; the composition (which tile uses
 * which range) stays there.
 */
import type * as React from "react";
import type { TrafficRange } from "@/lib/analytics/value-bands";
import type { DataSummary } from "@/lib/analytics/trends";

export interface RangeDisplayConfig {
  range: TrafficRange | null;
}

/**
 * v1.11.4 — minutes→hours projection of a `DataSummary` for the sleep
 * tile. The server emits `summaries.SLEEP_DURATION` as per-night minutes;
 * the tile renders hours. Every value-bearing field (latest / min / max /
 * mean / median / avg7 / avg30 / avg30LastMonth / avg30LastYear) divides
 * by 60; the slope tuples scale their `slope` (per-day rate) by the same
 * factor so the trend arrow stays consistent; count / direction /
 * confidence are unit-free and pass through.
 */
export function toHoursSummary(s: DataSummary): DataSummary {
  const h = (v: number | null | undefined): number | null =>
    v == null ? null : Math.round((v / 60) * 100) / 100;
  const scaleSlope = (slope: DataSummary["slope7"]): DataSummary["slope7"] =>
    slope == null
      ? null
      : { ...slope, slope: Math.round((slope.slope / 60) * 1000) / 1000 };
  return {
    ...s,
    latest: h(s.latest),
    min: h(s.min),
    max: h(s.max),
    mean: h(s.mean),
    median: h(s.median),
    avg7: h(s.avg7),
    avg30: h(s.avg30),
    avg30LastMonth: h(s.avg30LastMonth),
    avg30LastYear: h(s.avg30LastYear),
    slope7: scaleSlope(s.slope7),
    slope30: scaleSlope(s.slope30),
  };
}

export function getRangeColorClass(
  value: number | null | undefined,
  config: RangeDisplayConfig,
): string | undefined {
  const range = config.range;
  if (value == null || !range) return undefined;
  const inGreen = value >= range.greenMin && value <= range.greenMax;
  const inOrange =
    !inGreen && value >= range.orangeMin && value <= range.orangeMax;

  if (inGreen) return "text-success";
  if (inOrange) return "text-warning";
  return "text-destructive";
}

export function getRangeHint(
  unit: string,
  config: RangeDisplayConfig,
  t: (key: string) => string,
  formatNumber: (value: number, fractionDigits?: number) => string,
): React.ReactNode | undefined {
  const range = config.range;
  if (!range) return undefined;

  const format = (value: number) => formatNumber(value, 1);

  return (
    <>
      <p>
        <span className="text-success font-bold">{t("charts.colorGreen")}</span>{" "}
        {format(range.greenMin)}-{format(range.greenMax)} {unit}
      </p>
      <p>
        <span className="text-warning font-bold">
          {t("charts.colorOrange")}
        </span>{" "}
        {format(range.orangeMin)}-{format(range.greenMin)} {t("common.or")}{" "}
        {format(range.greenMax)}-{format(range.orangeMax)} {unit}
      </p>
      <p>
        <span className="text-destructive font-bold">
          {t("charts.colorRed")}
        </span>{" "}
        {"< "}
        {format(range.orangeMin)} {t("common.or")} {"> "}
        {format(range.orangeMax)} {unit}
      </p>
    </>
  );
}
