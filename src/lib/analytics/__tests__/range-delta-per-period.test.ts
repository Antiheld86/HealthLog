import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readRollupBuckets: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: mocks.findMany } },
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  readRollupBuckets: mocks.readRollupBuckets,
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  aggregateWmyBuckets: vi.fn(),
  readBestGranularityRollups: vi.fn(async () => null),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "UTC"),
}));

import {
  computeRangeDelta,
  dailyTotalsEndKey,
  splitDailyTotals,
} from "@/lib/analytics/range-delta";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 5, 30, 12);

function dayRow(daysAgo: number, total: number, samples: number) {
  const bucketStart = new Date(Date.UTC(2026, 5, 30) - daysAgo * DAY_MS);
  return {
    bucketStart,
    count: samples,
    mean: total / samples,
    minValue: 0,
    maxValue: total,
    sd: null,
    slope: null,
    r2: null,
    computedAt: bucketStart,
  };
}

beforeEach(() => {
  mocks.readRollupBuckets.mockReset();
  mocks.findMany.mockReset();
});

describe("computeRangeDelta — per-day and per-night metrics", () => {
  it("compares average daily step totals, not the mean of the readings", async () => {
    // Six complete days of 8,000 in the previous week and five in the
    // current one. Today is still arriving as 200 small samples and must not
    // count: its partial total made every morning's delta read "down".
    mocks.readRollupBuckets.mockResolvedValue([
      ...[8, 9, 10, 11, 12, 13].map((d) => dayRow(d, 8000, 1)),
      ...[1, 2, 3, 4, 5].map((d) => dayRow(d, 8000, 1)),
      dayRow(0, 4000, 200),
    ]);

    const result = await computeRangeDelta("u", "ACTIVITY_STEPS", "7d", NOW);

    expect(result.granularity).toBe("DAY");
    expect(result.previous).toMatchObject({ count: 6, mean: 8000 });
    expect(result.current).toMatchObject({ count: 5, mean: 8000, sum: 40_000 });
    expect(result.delta).toBe(0);
    const [, , , from, to] = mocks.readRollupBuckets.mock.calls[0]!;
    expect((from as Date).toISOString()).toBe("2026-06-16T00:00:00.000Z");
    expect((to as Date).toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });

  it.each([
    // West of UTC in the evening: the UTC day already rolled over, the
    // user's calendar did not.
    ["America/New_York", "2026-07-01T01:00:00.000Z", "2026-06-29"],
    // East of UTC in the early morning: the bucket keyed yesterday is still
    // filling until UTC midnight.
    ["Asia/Tokyo", "2026-06-29T20:00:00.000Z", "2026-06-28"],
    ["Europe/Berlin", "2026-06-30T06:00:00.000Z", "2026-06-29"],
    ["UTC", "2026-06-30T12:00:00.000Z", "2026-06-29"],
  ])("ends the daily-total window on a completed day in %s", (tz, iso, end) => {
    expect(dailyTotalsEndKey(Date.parse(iso), tz)).toBe(end);
  });

  it("splits daily totals on day keys ending at the end key", () => {
    const points = [
      { day: "2026-06-30", value: 100 },
      { day: "2026-06-29", value: 9000 },
      { day: "2026-06-23", value: 9000 },
      { day: "2026-06-22", value: 7000 },
      { day: "2026-06-16", value: 7000 },
      { day: "2026-06-15", value: 1 },
    ];
    const { current, previous } = splitDailyTotals(points, 7, "2026-06-29");
    expect(current).toMatchObject({ count: 2, mean: 9000 });
    expect(previous).toMatchObject({ count: 2, mean: 7000 });
  });

  it("compares average nights of sleep, not the mean of stage rows", async () => {
    const row = (iso: string, minutes: number, sleepStage: string) => ({
      value: minutes,
      measuredAt: new Date(iso),
      sleepStage,
      source: "APPLE_HEALTH",
      deviceType: null,
    });
    // Two nights: 7 h asleep (split into three stage rows plus an in-bed
    // envelope) and 6 h asleep.
    mocks.findMany.mockResolvedValue([
      row("2026-06-28T01:00:00.000Z", 480, "IN_BED"),
      row("2026-06-28T02:00:00.000Z", 180, "CORE"),
      row("2026-06-28T04:00:00.000Z", 120, "DEEP"),
      row("2026-06-28T06:00:00.000Z", 120, "REM"),
      row("2026-06-29T06:00:00.000Z", 360, "ASLEEP"),
    ]);

    const result = await computeRangeDelta("u", "SLEEP_DURATION", "7d", NOW);

    expect(result.granularity).toBe("live");
    expect(result.current.count).toBe(2);
    expect(result.current.mean).toBeCloseTo(390, 6);
  });
});
