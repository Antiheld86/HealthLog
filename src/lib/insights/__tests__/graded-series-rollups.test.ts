import { afterEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
    // loadUserSourcePriority lazy-loads the source-priority blob; null
    // (default findUnique) falls back to the default ladders.
    user: { findUnique: vi.fn() },
  },
}));

const readDayAggregates = vi.fn();
vi.mock("@/lib/measurements/day-aggregates", () => ({
  readDayAggregates: (...args: unknown[]) => readDayAggregates(...args),
}));

const readBestGranularityRollups = vi.fn();
const rollupRow = (bucketStart: Date, mean: number) => ({
  bucketStart,
  count: 30,
  mean,
  sd: null,
  slope: null,
  r2: null,
  sumValue: null,
  minValue: mean - 1,
  maxValue: mean + 1,
});
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: (...args: unknown[]) =>
    readBestGranularityRollups(...args),
  aggregateWmyBuckets: vi.fn(),
}));

import {
  buildGradedSeriesFromDayAggregates,
  buildGradedSeriesFromPoints,
  buildGradedSeriesWithRollups,
} from "../graded-series";
import { foldDayAggregates } from "@/lib/measurements/__tests__/fake-day-aggregates";
import type { ReadDayAggregatesOptions } from "@/lib/measurements/day-aggregates";

const dayMs = 24 * 60 * 60 * 1000;

/** Readings spanning `days` back from `now`, `perDay` per day. */
function points(days: number, now: Date, perDay = 1) {
  const rows: Array<{ measuredAt: Date; value: number }> = [];
  for (let i = 0; i < days; i++) {
    for (let k = 0; k < perDay; k++) {
      rows.push({
        measuredAt: new Date(now.getTime() - i * dayMs - k * 3_600_000),
        value: 60 + ((i * 7 + k * 3) % 41),
      });
    }
  }
  return rows.reverse();
}

/** Serve `readDayAggregates` from an in-memory row set. */
function serveFrom(rows: Array<{ measuredAt: Date; value: number }>) {
  readDayAggregates.mockImplementation(async (opts: ReadDayAggregatesOptions) =>
    foldDayAggregates(rows, opts),
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildGradedSeriesWithRollups — bounded reads (#1023)", () => {
  const now = new Date("2026-05-31T12:00:00Z");

  it("never materialises raw rows: the recent read is a per-day aggregate", async () => {
    serveFrom(points(80, now, 24));
    readBestGranularityRollups.mockResolvedValue({
      granularity: "MONTH",
      rows: [rollupRow(new Date("2025-09-01T00:00:00Z"), 79)],
    });

    await buildGradedSeriesWithRollups("u1", "PULSE", now);

    expect(findMany).not.toHaveBeenCalled();
    const opts = readDayAggregates.mock.calls[0][0] as ReadDayAggregatesOptions;
    expect(opts).toMatchObject({ userId: "u1", type: "PULSE" });
    expect(opts.until).toEqual(now);
    expect(opts.timeZone).toBe("Europe/Berlin");
    expect(now.getTime() - opts.since.getTime()).toBe(91 * dayMs);
    // The same age partition the parity test below proves exact: a reading
    // exactly 21 / 91 / 451 days old belongs to the older slice.
    expect(opts.segmentStarts).toEqual(
      [21, 91, 451].map((d) => new Date(now.getTime() - d * dayMs + 1)),
    );
  });

  it("folds monthly/yearly from the bounded fallback when the tier has no coverage", async () => {
    serveFrom(points(800, now));
    readBestGranularityRollups.mockResolvedValue(null);

    const series = await buildGradedSeriesWithRollups("u1", "WEIGHT", now);

    expect(series.monthly.length).toBeGreaterThan(0);
    expect(series.yearly.length).toBeGreaterThan(0);
    expect(readDayAggregates).toHaveBeenCalledTimes(2);
    const fallback = readDayAggregates.mock
      .calls[1][0] as ReadDayAggregatesOptions;
    // Bounded to the yearly router's horizon, never an unwindowed walk.
    expect(fallback.since.getTime()).toBe(now.getTime() - 1095 * dayMs);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reads monthly/yearly from the tier when it has coverage and skips the fallback", async () => {
    serveFrom(points(80, now));
    readBestGranularityRollups.mockImplementation(
      async (_u: string, _t: string, windowDays: number) =>
        windowDays === 365
          ? {
              granularity: "MONTH",
              rows: [
                rollupRow(new Date("2025-09-01T00:00:00Z"), 79),
                rollupRow(new Date("2025-10-01T00:00:00Z"), 80),
              ],
            }
          : {
              granularity: "YEAR",
              rows: [rollupRow(new Date("2023-01-01T00:00:00Z"), 82)],
            },
    );

    const series = await buildGradedSeriesWithRollups("u1", "WEIGHT", now);

    expect(series.monthly.length).toBeGreaterThan(0);
    expect(series.yearly.length).toBeGreaterThan(0);
    expect(readDayAggregates).toHaveBeenCalledTimes(1);
  });

  it("falls back only for the slice the tier misses", async () => {
    serveFrom(points(800, now));
    readBestGranularityRollups.mockImplementation(
      async (_u: string, _t: string, windowDays: number) =>
        windowDays === 365
          ? {
              granularity: "MONTH",
              rows: [rollupRow(new Date("2025-10-01T00:00:00Z"), 80)],
            }
          : null,
    );

    const series = await buildGradedSeriesWithRollups("u1", "WEIGHT", now);

    expect(series.monthly).toHaveLength(1);
    expect(series.yearly.length).toBeGreaterThan(0);
    expect(readDayAggregates).toHaveBeenCalledTimes(2);
  });
});

describe("buildGradedSeriesFromDayAggregates — parity with the raw fold", () => {
  const now = new Date("2026-05-31T12:00:00Z");
  const segmentStarts = [21, 91, 451].map(
    (d) => new Date(now.getTime() - d * dayMs + 1),
  );

  it("matches the raw-row fold for recent / weekly / monthly and yearly stats", () => {
    // Several readings per day, including readings exactly on the segment
    // edges, so the partition itself is under test.
    const rows = [
      ...points(900, now, 5),
      { measuredAt: new Date(now.getTime() - 21 * dayMs), value: 99 },
      { measuredAt: new Date(now.getTime() - 91 * dayMs), value: 41 },
    ];
    const raw = buildGradedSeriesFromPoints(rows, now);
    const agg = buildGradedSeriesFromDayAggregates(
      foldDayAggregates(rows, {
        since: new Date(0),
        until: now,
        timeZone: "Europe/Berlin",
        segmentStarts,
      }),
    );
    expect(agg.recent).toEqual(raw.recent);
    expect(agg.weekly).toEqual(raw.weekly);
    expect(agg.monthly).toEqual(raw.monthly);
    // The yearly slope runs over day means rather than single readings;
    // every other yearly figure is exact.
    expect(agg.yearly.map(({ slope: _s, ...b }) => b)).toEqual(
      raw.yearly.map(({ slope: _s, ...b }) => b),
    );
  });
});
