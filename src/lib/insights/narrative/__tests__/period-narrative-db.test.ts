/**
 * v1.30.3 (QA F2/F3) — `buildPeriodNarrativeContext` (the DB wrapper) must:
 *   - order its measurement read DESC + cap, resorting ASC before folding,
 *     so a dense account's cap falls on the OLDEST rows and never drops
 *     the CURRENT period (F2 — the asc+take(20000) cap used to drop the
 *     current period first, the worst possible direction for a
 *     current-vs-prior surface);
 *   - route every type through `buildMeasurementDailySeries`'s per-type
 *     grain (sleep = per-night SUM, cumulative = source-collapsed SUM),
 *     not the local `toDailyMeans` twin that used to blindly average
 *     every type including sleep-stage segments (F3).
 *
 * This exercises the real DB wrapper (mocked prisma), not just the pure
 * `assemblePeriodNarrativeContext` core the sibling test file covers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindUnique = vi.fn();
const measurementFindMany = vi.fn();
const moodFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => userFindUnique(a) },
    measurement: { findMany: (a: unknown) => measurementFindMany(a) },
    moodEntry: { findMany: (a: unknown) => moodFindMany(a) },
  },
}));

import { buildPeriodNarrativeContext } from "../period-narrative";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  userFindUnique.mockReset().mockResolvedValue({
    timezone: "UTC",
    sourcePriorityJson: null,
  });
  measurementFindMany.mockReset();
  moodFindMany.mockReset().mockResolvedValue([]);
});

describe("buildPeriodNarrativeContext — grain (QA F3)", () => {
  it("sums a night's per-stage segments into the SLEEP_DURATION delta instead of averaging them", async () => {
    // `now` deep enough into the week that a full current + prior 7-day
    // span (plus the +1 day lag slack) has clean, unambiguous UTC days.
    const now = new Date("2026-06-30T12:00:00.000Z");

    // WEIGHT + PULSE: 14 daily readings each (current + prior week) so both
    // clear the >=3-covered-day floor and the >=2-metrics-covered gate.
    const dailyMetricRows: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let i = 0; i < 14; i++) {
      const at = new Date(now.getTime() - i * DAY_MS - 6 * 60 * 60 * 1000);
      dailyMetricRows.push({ type: "WEIGHT", value: 80, measuredAt: at });
      dailyMetricRows.push({ type: "PULSE", value: 60, measuredAt: at });
    }

    // One night THIS week: CORE 240 + DEEP 90 + REM 80 = 410 minutes total
    // asleep. `measuredAt` is the END of each segment (reconstructor derives
    // the start from `measuredAt - value minutes`), matching
    // `sleep-night.test.ts` / `correlation-channel-series.test.ts`.
    const nightEnd = new Date(now.getTime() - 1 * DAY_MS);
    const sleepRows = [
      {
        type: "SLEEP_DURATION",
        value: 240,
        measuredAt: new Date(nightEnd.getTime() - 3 * 60 * 60 * 1000),
        source: "APPLE_HEALTH",
        deviceType: null,
        sleepStage: "CORE",
      },
      {
        type: "SLEEP_DURATION",
        value: 90,
        measuredAt: new Date(nightEnd.getTime() - 1.5 * 60 * 60 * 1000),
        source: "APPLE_HEALTH",
        deviceType: null,
        sleepStage: "DEEP",
      },
      {
        type: "SLEEP_DURATION",
        value: 80,
        measuredAt: nightEnd,
        source: "APPLE_HEALTH",
        deviceType: null,
        sleepStage: "REM",
      },
    ];

    measurementFindMany.mockResolvedValue([
      ...dailyMetricRows.map((r) => ({
        ...r,
        source: "MANUAL",
        deviceType: null,
        sleepStage: null,
      })),
      ...sleepRows,
    ]);

    const result = await buildPeriodNarrativeContext("u1", {
      period: "week",
      now,
      locale: "en",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const sleepDelta = result.metricDeltas.find(
      (d) => d.type === "SLEEP_DURATION",
    );
    expect(sleepDelta).toBeDefined();
    // The pre-fix local `toDailyMeans` twin would have averaged the three
    // segment durations: (240 + 90 + 80) / 3 ≈ 137 — a number with no
    // clinical meaning. The correct grain is the night's TOTAL (410).
    expect(sleepDelta!.current).toBe(410);
    expect(sleepDelta!.current).not.toBeCloseTo((240 + 90 + 80) / 3, 0);
  });

  it("orders the measurement read DESC + cap so the CURRENT period survives a capped window (QA F2)", async () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    measurementFindMany.mockResolvedValue([]);

    await buildPeriodNarrativeContext("u1", {
      period: "week",
      now,
      locale: "en",
    });

    expect(measurementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { measuredAt: "desc" },
        take: 20000,
      }),
    );
  });
});
