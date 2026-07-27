/**
 * F1 — rollup-vs-live golden for the Health Score.
 *
 * `computeUserHealthScoreFastPath` reads the weight series two ways: per-day
 * MEAN buckets off `measurement_rollups` when the WEIGHT type is covered, raw
 * `measurements` rows otherwise. The scoring math cannot diverge — there is one
 * scorer and both branches call it — but the INPUT SERIES can, and nothing in
 * the suite asserted the two branches land on the same number for the same
 * underlying readings. The existing fast-path tests exercise each branch alone.
 *
 * This file encodes one series both ways and pins the equivalence, plus the one
 * documented case where the two legitimately differ: with several readings on a
 * day, the rollup branch regresses over the day's mean while the live branch
 * regresses over every reading. That is a collapse, not a bug — so the second
 * suite pins that the rollup branch equals the live branch fed those same daily
 * means, which is the exact claim the fast-path's own comment makes.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/rollups/measurement-coverage", () => ({
  isFullyCovered: vi.fn(),
  probeRollupCoverage: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { computeUserHealthScoreFastPath } from "../health-score-fast-path";

const MEASUREMENT_FIND_MANY = prisma.measurement
  .findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY = prisma.measurementRollup
  .findMany as unknown as ReturnType<typeof vi.fn>;
const MOOD_FIND_MANY = prisma.moodEntry.findMany as unknown as ReturnType<
  typeof vi.fn
>;
const MEDICATION_FIND_MANY = prisma.medication
  .findMany as unknown as ReturnType<typeof vi.fn>;
const PROBE = probeRollupCoverage as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-05-20T12:00:00.000Z");

/** A weight reading in the shared fixture vocabulary. */
interface Reading {
  /** Days before `NOW` the reading was taken. */
  daysAgo: number;
  /** Hour of that day, so several readings can share a day. */
  hour: number;
  kg: number;
}

function measuredAt(r: Reading): Date {
  const d = new Date(NOW.getTime() - r.daysAgo * 24 * 60 * 60 * 1000);
  d.setUTCHours(r.hour, 0, 0, 0);
  return d;
}

/** UTC midnight of a reading's day — the DAY bucket key. */
function bucketStart(r: Reading): Date {
  const d = measuredAt(r);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/** Collapse readings into the per-day MEAN buckets the rollup tier stores. */
function toDayBuckets(readings: Reading[]) {
  const byDay = new Map<number, { sum: number; count: number }>();
  for (const r of readings) {
    const key = bucketStart(r).getTime();
    const slot = byDay.get(key) ?? { sum: 0, count: 0 };
    slot.sum += r.kg;
    slot.count += 1;
    byDay.set(key, slot);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, slot]) => ({
      bucketStart: new Date(ms),
      count: slot.count,
      mean: slot.sum / slot.count,
      minValue: slot.sum / slot.count,
      maxValue: slot.sum / slot.count,
      sd: null,
      slope: null,
      r2: null,
      computedAt: NOW,
    }));
}

beforeEach(() => {
  MEASUREMENT_FIND_MANY.mockReset();
  ROLLUP_FIND_MANY.mockReset();
  MOOD_FIND_MANY.mockReset();
  MEDICATION_FIND_MANY.mockReset();
  PROBE.mockReset();

  MOOD_FIND_MANY.mockResolvedValue([]);
  MEDICATION_FIND_MANY.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Score the readings through the ROLLUP branch (WEIGHT covered). */
async function scoreViaRollup(readings: Reading[]) {
  const coverage = new Map<string, boolean>([["WEIGHT", true]]);
  PROBE.mockResolvedValue(coverage);
  const buckets = toDayBuckets(readings);
  // The DAY read and the long-window (WEEK/MONTH/YEAR) read fire in parallel,
  // so key the mock on the requested granularity rather than call order.
  ROLLUP_FIND_MANY.mockImplementation(
    async ({ where }: { where: { granularity: string } }) =>
      where.granularity === "DAY" ? buckets : [],
  );
  // Source attribution still comes off the raw rows (2-column projection),
  // then the BP-SYS attribution read.
  MEASUREMENT_FIND_MANY.mockResolvedValueOnce(
    readings.map((r) => ({ measuredAt: measuredAt(r), source: "MANUAL" })),
  ).mockResolvedValueOnce([]);

  return computeUserHealthScoreFastPath({
    userId: "user-rollup",
    bpInTargetPct: null,
    weightTarget: null,
    weightTargetSource: "none",
    now: NOW,
    coverage,
    moodEnabled: true,
  });
}

/** Score the readings through the LIVE branch (WEIGHT uncovered). */
async function scoreViaLive(readings: Reading[]) {
  const coverage = new Map<string, boolean>([["WEIGHT", false]]);
  PROBE.mockResolvedValue(coverage);
  MEASUREMENT_FIND_MANY.mockResolvedValueOnce(
    readings.map((r) => ({
      measuredAt: measuredAt(r),
      value: r.kg,
      source: "MANUAL",
    })),
  ).mockResolvedValueOnce([]);

  return computeUserHealthScoreFastPath({
    userId: "user-live",
    bpInTargetPct: null,
    weightTarget: null,
    weightTargetSource: "none",
    now: NOW,
    coverage,
    moodEnabled: true,
  });
}

describe("Health Score — rollup / live parity on one weigh-in per day", () => {
  // The canonical cadence: one weigh-in a day, the pattern the fast path's own
  // comment says the equivalence rests on.
  const dailyDecline: Reading[] = [
    { daysAgo: 24, hour: 7, kg: 84.0 },
    { daysAgo: 20, hour: 7, kg: 83.6 },
    { daysAgo: 16, hour: 7, kg: 83.1 },
    { daysAgo: 12, hour: 7, kg: 82.7 },
    { daysAgo: 8, hour: 7, kg: 82.2 },
    { daysAgo: 4, hour: 7, kg: 81.8 },
    { daysAgo: 1, hour: 7, kg: 81.5 },
  ];

  it("produces the same score, band and weight pillar on both branches", async () => {
    const rollup = await scoreViaRollup(dailyDecline);
    const live = await scoreViaLive(dailyDecline);

    expect(rollup).not.toBeNull();
    expect(live).not.toBeNull();
    expect(rollup?.score).toBe(live?.score);
    expect(rollup?.band).toBe(live?.band);
    expect(rollup?.components.weight.value).toBe(live?.components.weight.value);
    // The weight pillar is the whole score here (no BP, mood or medications),
    // so an equal score is only meaningful if the pillar actually resolved.
    expect(rollup?.components.weight.value).not.toBeNull();
  });

  it("agrees on the week-over-week delta too", async () => {
    // The delta re-runs the scorer over a 7-day-shifted window, so it exercises
    // the branch's series construction a second time on a different slice.
    const rollup = await scoreViaRollup(dailyDecline);
    const live = await scoreViaLive(dailyDecline);
    expect(rollup?.delta).toBe(live?.delta);
  });

  it("agrees on a rising series as well as a falling one", async () => {
    const rise = dailyDecline.map((r) => ({ ...r, kg: 160 - r.kg }));
    const rollup = await scoreViaRollup(rise);
    const live = await scoreViaLive(rise);
    expect(rollup?.score).toBe(live?.score);
    expect(rollup?.components.weight.value).toBe(live?.components.weight.value);
  });
});

describe("Health Score — rollup / live on an uneven weigh-in cadence", () => {
  // Three weigh-ins on the older day, one on the recent day. Per-reading
  // regression weights that older day three times over; per-day-mean regression
  // gives it one point. This is the shape where the two branches genuinely part
  // company, so it is the shape worth pinning.
  const uneven: Reading[] = [
    { daysAgo: 20, hour: 6, kg: 85.0 },
    { daysAgo: 20, hour: 12, kg: 84.0 },
    { daysAgo: 20, hour: 20, kg: 83.0 },
    { daysAgo: 2, hour: 7, kg: 83.6 },
  ];

  /** The same readings collapsed to one per day at their daily mean. */
  const collapsed: Reading[] = toDayBuckets(uneven).map((b) => ({
    daysAgo: Math.round(
      (NOW.getTime() - b.bucketStart.getTime()) / (24 * 60 * 60 * 1000),
    ),
    hour: 0,
    kg: b.mean,
  }));

  it("the two branches do differ here — the fixture is not a no-op", async () => {
    // Guard the guard: if raw and collapsed ever scored the same for this
    // series, the equality below would prove nothing.
    const liveOnRaw = await scoreViaLive(uneven);
    const liveOnMeans = await scoreViaLive(collapsed);
    expect(liveOnRaw?.components.weight.value).not.toBe(
      liveOnMeans?.components.weight.value,
    );
  });

  it("the rollup branch equals the live branch fed the same daily means", async () => {
    // The whole difference between the branches is the mean-collapse and
    // nothing else: replay the collapsed series through the LIVE branch and the
    // two agree again. That is the claim the fast path's own comment makes,
    // stated as a test rather than left as prose.
    const rollup = await scoreViaRollup(uneven);
    const liveOnMeans = await scoreViaLive(collapsed);

    expect(rollup?.score).toBe(liveOnMeans?.score);
    expect(rollup?.components.weight.value).toBe(
      liveOnMeans?.components.weight.value,
    );
  });
});
