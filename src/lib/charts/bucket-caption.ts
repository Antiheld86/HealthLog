/**
 * What a chart point means once the visible range folds days into weeks or
 * months, as the caption and the tooltip name it.
 *
 * Every point of a week or month is the average day of that bucket, on every
 * read path (the day points the chart folds itself, and the rollup tier rows
 * the server serves for the "All" range). For a level (weight, pulse) that is
 * simply the week's or month's average. For a cumulative metric (steps,
 * energy, distance) it is the average DAILY total, which keeps the axis
 * comparable with the 7, 30 and 90 day tabs; calling it a "weekly average"
 * read as an average week's total, a figure seven times larger.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import type { ChartBucketType } from "@/lib/charts/bucket-time-series";

export function bucketCaptionKey(
  bucket: ChartBucketType,
  types: readonly string[],
): string | null {
  if (bucket === "day") return null;
  const daily =
    types.length > 0 &&
    types.every((type) => CUMULATIVE_HK_TYPES.has(type as MeasurementType));
  if (bucket === "week") {
    return daily ? "charts.bucketWeeklyDaily" : "charts.bucketWeekly";
  }
  return daily ? "charts.bucketMonthlyDaily" : "charts.bucketMonthly";
}
