/**
 * v1.9.0 — period-over-period range deltas for a single metric.
 *
 * Background
 * ----------
 * The Insights metric pages render fixed windows (`avg7`, `avg30`,
 * `slope7/30/90`). A user-selectable time-range with a "vs prior period"
 * delta needs two reads of the same metric: the current window and the
 * previous comparable window, composed into a delta. This is exactly the
 * two-window pattern `computeAvg30LastYearForType` already uses for the
 * year-ago baseline (`summaries-slice.ts`) — current = the trailing window,
 * previous = the equally-sized window immediately before it.
 *
 * Single metric, two reads, no fan-out
 * ------------------------------------
 * The route this backs is single-metric (the metric page is single-metric),
 * so the cost is one `readBestGranularityRollups` call covering the trailing
 * `2N` days, sliced into the current and previous halves. No per-type fan-out,
 * no Prisma-pool burst — the opposite of the deleted 15-way live walk.
 *
 * Compositional contract
 * ----------------------
 * `count / min / max / mean / sum` are linearly composable across buckets
 * (the rollup tier's compositional contract — `measurement-read-wmy.ts`), so
 * a window aggregate built from WEEK / MONTH buckets equals the per-row
 * aggregate over the same span. SD / slope / r² are intentionally NOT part of
 * the delta — they do not compose, matching the rest of the WMY reader tier.
 *
 * Two kinds of metric are not averaged per reading:
 *   - step-like totals (steps, energy, distance, flights, …) compare the
 *     average DAILY total: a day's readings are pieces of one total, and the
 *     last day and a half still arrives as many small samples before the
 *     drain folds them, so a per-reading mean collapsed the current window;
 *   - sleep compares the average NIGHT (time asleep, reconstructed from the
 *     stage rows): a per-row mean averaged stage segments and in-bed
 *     envelopes, which is no amount of sleep at all.
 * For both, `count` is the number of days or nights.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { readRollupBuckets } from "@/lib/rollups/measurement-rollups";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  aggregateWmyBuckets,
  readBestGranularityRollups,
  type RollupBucketRow,
} from "@/lib/rollups/measurement-read-wmy";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  ANALYTICS_RANGES,
  rangeWindowDays,
  type AnalyticsRange,
  type RangeDeltaResult,
  type WindowAggregate,
} from "@/lib/analytics/range-shared";

// The range constants + result shapes live in the client-safe
// `range-shared` module so the insights client bundle never pulls the
// server-only rollup readers (and `pg`) through a range import. Re-exported
// here so existing server-side callers keep importing from `range-delta`.
export {
  ANALYTICS_RANGES,
  rangeWindowDays,
  type AnalyticsRange,
  type RangeDeltaResult,
  type WindowAggregate,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Slice the resolved buckets into the current half (`[now-N, now)`) and the
 * previous half (`[now-2N, now-N)`) and compose each. Pure over the bucket
 * rows + the window boundaries so the composition is unit-testable without a
 * DB. `bucketStart` is the slice key — the same conservative overlap filter
 * `computeAvg30LastYearForType` uses (a bucket counts toward the half its
 * `bucketStart` falls into).
 */
export function sliceWindowDelta(
  rows: RollupBucketRow[],
  windowDays: number,
  now: number,
): { current: WindowAggregate; previous: WindowAggregate } {
  const currentStart = now - windowDays * DAY_MS;
  const previousStart = now - 2 * windowDays * DAY_MS;
  const currentRows: RollupBucketRow[] = [];
  const previousRows: RollupBucketRow[] = [];
  for (const row of rows) {
    const t = row.bucketStart.getTime();
    if (t >= currentStart && t < now) {
      currentRows.push(row);
    } else if (t >= previousStart && t < currentStart) {
      previousRows.push(row);
    }
  }
  return {
    current: aggregateWmyBuckets(currentRows),
    previous: aggregateWmyBuckets(previousRows),
  };
}

/**
 * Aggregate one value per day or night (a daily total, a night's time
 * asleep): `count` is the number of days or nights, `mean` their average.
 */
export function aggregatePerPeriod(values: readonly number[]): WindowAggregate {
  if (values.length === 0) {
    return { count: 0, min: null, max: null, mean: null, sum: null };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { count: values.length, min, max, mean: sum / values.length, sum };
}

/** Split `(at, value)` points into the current and previous halves. */
function splitPerPeriod(
  points: ReadonlyArray<{ at: Date; value: number }>,
  windowDays: number,
  now: number,
): { current: WindowAggregate; previous: WindowAggregate } {
  const currentStart = now - windowDays * DAY_MS;
  const previousStart = now - 2 * windowDays * DAY_MS;
  const current: number[] = [];
  const previous: number[] = [];
  for (const p of points) {
    const t = p.at.getTime();
    if (t >= currentStart && t < now) current.push(p.value);
    else if (t >= previousStart && t < currentStart) previous.push(p.value);
  }
  return {
    current: aggregatePerPeriod(current),
    previous: aggregatePerPeriod(previous),
  };
}

/** The canonical daily totals of a step-like metric, one point per day. */
async function readDailyTotals(
  userId: string,
  type: MeasurementType,
  windowDays: number,
  now: number,
): Promise<Array<{ at: Date; value: number }>> {
  const rows = await readRollupBuckets(
    userId,
    type,
    "DAY",
    startOfUtcDay(new Date(now - 2 * windowDays * DAY_MS)),
    new Date(now),
  );
  return rows.map((r) => ({ at: r.bucketStart, value: r.mean * r.count }));
}

/** Time asleep per reconstructed night, one point per night. */
async function readNightlySleep(
  userId: string,
  windowDays: number,
  now: number,
): Promise<Array<{ at: Date; value: number }>> {
  // A night's rows start the evening before its wake day: read one day more.
  const rows = (await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION",
      deletedAt: null,
      measuredAt: {
        gte: new Date(now - (2 * windowDays + 1) * DAY_MS),
        lt: new Date(now),
      },
    },
    orderBy: { measuredAt: "asc" },
    select: {
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
  })) as SleepStageRow[];
  if (rows.length === 0) return [];
  const [tz, priorityJson] = await Promise.all([
    resolveUserTimezone(userId),
    loadUserSourcePriority(userId),
  ]);
  return reconstructSleepNights(rows, tz, priorityJson)
    .filter((n) => n.asleepMinutes > 0)
    .map((n) => ({ at: n.measuredAt, value: n.asleepMinutes }));
}

/**
 * Compose the period-over-period delta from the two window aggregates.
 * Pure — pinned by unit test. Guards both the missing-data case (either
 * window empty → delta null) and the divide-by-zero case (prior mean zero or
 * null → deltaPct null) so the caption never paints a misleading 0 %.
 */
export function composeDelta(
  current: WindowAggregate,
  previous: WindowAggregate,
): { delta: number | null; deltaPct: number | null } {
  if (current.mean === null || previous.mean === null) {
    return { delta: null, deltaPct: null };
  }
  const delta = current.mean - previous.mean;
  const deltaPct = previous.mean !== 0 ? delta / previous.mean : null;
  return { delta, deltaPct };
}

/**
 * Read the current vs previous window for one `(userId, type)` and compose
 * the delta. Reads a single `2N`-day window through the granularity router so
 * both halves resolve at the same granularity (the comparison stays
 * apples-to-apples). Returns a zeroed result on a coverage miss — the route
 * still answers 200 with empty windows so the UI shows "no prior-period
 * data" rather than erroring.
 */
export async function computeRangeDelta(
  userId: string,
  type: MeasurementType,
  range: AnalyticsRange,
  now: number = Date.now(),
): Promise<RangeDeltaResult> {
  const windowDays = rangeWindowDays(range);

  if (type === "SLEEP_DURATION" || CUMULATIVE_HK_TYPES.has(type)) {
    const points =
      type === "SLEEP_DURATION"
        ? await readNightlySleep(userId, windowDays, now)
        : await readDailyTotals(userId, type, windowDays, now);
    const { current, previous } = splitPerPeriod(points, windowDays, now);
    const { delta, deltaPct } = composeDelta(current, previous);
    return {
      range,
      windowDays,
      granularity:
        points.length === 0
          ? "none"
          : type === "SLEEP_DURATION"
            ? "live"
            : "DAY",
      current,
      previous,
      delta,
      deltaPct,
    };
  }

  // Read the full 2N span in one go so the current and previous halves share
  // a granularity; the router picks the coarsest tier that resolves 2N.
  const resolved = await readBestGranularityRollups(
    userId,
    type,
    windowDays * 2,
  );
  if (!resolved) {
    const empty: WindowAggregate = {
      count: 0,
      min: null,
      max: null,
      mean: null,
      sum: null,
    };
    return {
      range,
      windowDays,
      granularity: "none",
      current: empty,
      previous: empty,
      delta: null,
      deltaPct: null,
    };
  }
  const { current, previous } = sliceWindowDelta(
    resolved.rows,
    windowDays,
    now,
  );
  const { delta, deltaPct } = composeDelta(current, previous);
  return {
    range,
    windowDays,
    granularity: resolved.granularity,
    current,
    previous,
    delta,
    deltaPct,
  };
}
