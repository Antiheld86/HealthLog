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

import { computeRangeDelta } from "@/lib/analytics/range-delta";

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
    // Six complete days of 8,000 in the previous week, and in the current
    // week five drained days plus today still arriving as 200 samples.
    mocks.readRollupBuckets.mockResolvedValue([
      ...[8, 9, 10, 11, 12, 13].map((d) => dayRow(d, 8000, 1)),
      ...[1, 2, 3, 4, 5].map((d) => dayRow(d, 8000, 1)),
      dayRow(0, 4000, 200),
    ]);

    const result = await computeRangeDelta("u", "ACTIVITY_STEPS", "7d", NOW);

    expect(result.granularity).toBe("DAY");
    expect(result.previous).toMatchObject({ count: 6, mean: 8000 });
    expect(result.current.count).toBe(6);
    expect(result.current.mean).toBeCloseTo((5 * 8000 + 4000) / 6, 6);
    expect(result.current.sum).toBeCloseTo(44_000, 6);
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
