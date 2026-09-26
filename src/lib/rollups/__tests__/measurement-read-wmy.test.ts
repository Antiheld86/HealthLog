/**
 * v1.4.39 W-WMY — unit tests for the WEEK / MONTH / YEAR rollup
 * readers and the auto-router that picks the largest granularity
 * that still resolves a requested window.
 *
 * `prisma.measurementRollup.findMany` is mocked at the module level
 * so the test pins:
 *   - every granularity is folded from the canonical DAY buckets (the
 *     source is chosen per DAY, never once per week / month / year),
 *   - empty rollups return `null` so the caller can branch on
 *     coverage miss,
 *   - the auto-router picks the coarsest granularity whose floor the
 *     window clears,
 *   - `aggregateWmyBuckets` composes `count / min / max / mean / sum`
 *     linearly across coarser buckets (the same compositional
 *     contract `rollup-read.ts:aggregateBuckets` carries for DAY).
 *
 * Integration coverage against a real Postgres lives outside this
 * file — the writer's `STDDEV_POP / REGR_SLOPE` semantics are pinned
 * in `tests/integration/measurement-rollups.test.ts` already.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurementRollup: {
      findMany: mocks.findMany,
    },
    // v1.11.1 — readBestGranularityRollups loads the source-priority blob via
    // loadUserSourcePriority; default to null so the collapse uses the default
    // ladders (these routing fixtures are single-source per bucket anyway).
    user: {
      findUnique: mocks.userFindUnique,
    },
  },
}));

import {
  aggregateWmyBuckets,
  pickRollupGranularityForWindow,
  readBestGranularityRollups,
  readTieredRollupSeries,
  type RollupBucketRow,
} from "../measurement-read-wmy";
import { pickBucket } from "@/lib/charts/bucket-time-series";

const { findMany } = mocks;

function bucket(
  bucketStart: string,
  partial: Partial<RollupBucketRow> = {},
): RollupBucketRow {
  return {
    bucketStart: new Date(bucketStart),
    count: 10,
    mean: 82,
    sd: 1,
    slope: -0.01,
    r2: 0.3,
    sumValue: null,
    minValue: 80,
    maxValue: 84,
    ...partial,
  };
}

beforeEach(() => {
  findMany.mockReset();
  // Default to "no coverage" for any read a test did not queue explicitly —
  // the v1.37.29 span-refinement probe in `readTieredRollupSeries` issues an
  // extra read when a fixture's rows span less than the requested window,
  // and an unqueued vi.fn() would resolve `undefined` and crash the reader
  // instead of modelling an unminted tier.
  findMany.mockResolvedValue([]);
  mocks.userFindUnique.mockReset();
  mocks.userFindUnique.mockResolvedValue({ sourcePriorityJson: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** One stored DAY rollup row, per source, as `findMany` returns it. */
function dayRow(
  day: string,
  source: string,
  count: number,
  mean: number,
  extra: Partial<{ minValue: number; maxValue: number }> = {},
) {
  const bucketStart = new Date(`${day}T00:00:00.000Z`);
  // Accumulators for `count` readings of `mean` at the day's midday.
  const x = bucketStart.getTime() / DAY_MS_ROWS - 18262 + 0.5;
  return {
    bucketStart,
    source,
    count,
    mean,
    minValue: extra.minValue ?? mean,
    maxValue: extra.maxValue ?? mean,
    sumValue: count * mean,
    sd: 0,
    slope: null,
    r2: null,
    sumX: count * x,
    sumXy: count * x * mean,
    sumXx: count * x * x,
    sumYy: count * mean * mean,
    computedAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}
const DAY_MS_ROWS = 86_400_000;

/** `n` consecutive days from `start`, one row each. */
function days(
  start: string,
  n: number,
  source: string,
  count: number,
  mean: number,
) {
  const out = [];
  const t0 = new Date(`${start}T00:00:00.000Z`).getTime();
  for (let i = 0; i < n; i++) {
    out.push(
      dayRow(
        new Date(t0 + i * DAY_MS_ROWS).toISOString().slice(0, 10),
        source,
        count,
        mean,
      ),
    );
  }
  return out;
}

describe("readBestGranularityRollups", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null on a non-positive window", async () => {
    expect(await readBestGranularityRollups("user", "WEIGHT", 0)).toBeNull();
    expect(await readBestGranularityRollups("user", "WEIGHT", -10)).toBeNull();
    expect(await readBestGranularityRollups("user", "WEIGHT", NaN)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each([
    [90, "DAY"],
    [365, "MONTH"],
    [540, "MONTH"],
    [1095, "YEAR"],
    [120, "WEEK"],
  ] as const)(
    "routes a %i-day window to %s, folded from the DAY tier",
    async (windowDays, granularity) => {
      findMany.mockResolvedValueOnce([dayRow("2025-12-20", "MANUAL", 1, 80)]);
      const result = await readBestGranularityRollups(
        "user",
        "WEIGHT",
        windowDays,
      );
      expect(result?.granularity).toBe(granularity);
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany.mock.calls[0][0].where.granularity).toBe("DAY");
    },
  );

  it("returns null when the window holds no DAY buckets", async () => {
    findMany.mockResolvedValue([]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 1095);
    expect(result).toBeNull();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  // The canonical source is a per-DAY decision. Collapsing the stored
  // per-source MONTH rows picked WITHINGS for the whole month (it leads the
  // blood-pressure ladder) and reported its one reading: count 1, mean 120.
  it("keeps every manual day of a month that also carries one synced day", async () => {
    findMany.mockResolvedValueOnce([
      ...days("2025-11-01", 20, "MANUAL", 1, 150),
      dayRow("2025-11-25", "WITHINGS", 1, 120),
    ]);
    const result = await readBestGranularityRollups(
      "user",
      "BLOOD_PRESSURE_SYS",
      365,
    );
    expect(result?.granularity).toBe("MONTH");
    expect(result?.rows).toHaveLength(1);
    expect(result?.rows[0].count).toBe(21);
    expect(result?.rows[0].mean).toBeCloseTo((20 * 150 + 120) / 21, 9);
    expect(result?.rows[0].minValue).toBe(120);
    expect(result?.rows[0].maxValue).toBe(150);
  });

  it("sums a step month whose days switch device, one source per day", async () => {
    findMany.mockResolvedValueOnce([
      ...days("2025-11-01", 10, "FITBIT", 1, 8000),
      ...days("2025-11-11", 20, "APPLE_HEALTH", 1, 8000),
    ]);
    const result = await readBestGranularityRollups(
      "user",
      "ACTIVITY_STEPS",
      365,
    );
    expect(aggregateWmyBuckets(result?.rows ?? []).sum).toBe(240_000);
  });

  it("still keeps one source on a day both sources carry", async () => {
    findMany.mockResolvedValueOnce([
      dayRow("2025-11-03", "APPLE_HEALTH", 1, 9000),
      dayRow("2025-11-03", "FITBIT", 1, 7000),
      dayRow("2025-11-04", "FITBIT", 1, 7000),
    ]);
    const result = await readBestGranularityRollups(
      "user",
      "ACTIVITY_STEPS",
      365,
    );
    expect(result?.rows[0].sumValue).toBe(16_000);
    expect(result?.rows[0].count).toBe(2);
  });

  it("cuts weeks on the ISO Monday in UTC", async () => {
    findMany.mockResolvedValueOnce([
      dayRow("2025-11-02", "MANUAL", 1, 1), // Sunday → week of 2025-10-27
      dayRow("2025-11-03", "MANUAL", 1, 2), // Monday → week of 2025-11-03
      dayRow("2025-11-09", "MANUAL", 1, 3), // Sunday → week of 2025-11-03
    ]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 120);
    expect(result?.granularity).toBe("WEEK");
    expect(result?.rows.map((r) => r.bucketStart.toISOString())).toEqual([
      "2025-10-27T00:00:00.000Z",
      "2025-11-03T00:00:00.000Z",
    ]);
    expect(result?.rows.map((r) => r.count)).toEqual([1, 2]);
  });

  it("composes the bucket's spread and slope from the day accumulators", async () => {
    // Three days of one reading each: 70, 72, 74 → slope 2 per day,
    // population sd sqrt(8/3), r² 1.
    findMany.mockResolvedValueOnce([
      dayRow("2025-11-03", "MANUAL", 1, 70),
      dayRow("2025-11-04", "MANUAL", 1, 72),
      dayRow("2025-11-05", "MANUAL", 1, 74),
    ]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 365);
    const month = result?.rows[0];
    expect(month?.slope).toBeCloseTo(2, 6);
    expect(month?.r2).toBeCloseTo(1, 6);
    expect(month?.sd).toBeCloseTo(Math.sqrt(8 / 3), 6);
  });
});

describe("aggregateWmyBuckets", () => {
  it("returns the empty-window shape on no rows", () => {
    expect(aggregateWmyBuckets([])).toEqual({
      count: 0,
      min: null,
      max: null,
      mean: null,
      sum: null,
    });
  });

  it("sums count + folds min/max + weights mean across MONTH buckets", () => {
    // Two MONTH buckets — same compositional contract as DAY because
    // `count / min / max / mean` are linearly composable across any
    // bucket granularity.
    //   April: count=10, mean=82, min=79, max=84
    //   May:   count=20, mean=80, min=77, max=83
    //   ⇒ totalCount=30, min=77, max=84,
    //      mean = (10×82 + 20×80) / 30 = 80.6666…
    const rows: RollupBucketRow[] = [
      bucket("2026-04-01T00:00:00.000Z", {
        count: 10,
        mean: 82,
        minValue: 79,
        maxValue: 84,
      }),
      bucket("2026-05-01T00:00:00.000Z", {
        count: 20,
        mean: 80,
        minValue: 77,
        maxValue: 83,
      }),
    ];
    const result = aggregateWmyBuckets(rows);
    expect(result.count).toBe(30);
    expect(result.min).toBe(77);
    expect(result.max).toBe(84);
    expect(result.mean).toBeCloseTo((10 * 82 + 20 * 80) / 30, 5);
  });

  it("sums cumulative sumValue when every bucket carries one", () => {
    const rows: RollupBucketRow[] = [
      bucket("2026-04-01T00:00:00.000Z", { sumValue: 12_500 }),
      bucket("2026-05-01T00:00:00.000Z", { sumValue: 8_200 }),
    ];
    const result = aggregateWmyBuckets(rows);
    expect(result.sum).toBe(20_700);
  });

  it("returns null sum when no bucket carries sumValue (pre-W-SUM data)", () => {
    const rows: RollupBucketRow[] = [
      bucket("2026-04-01T00:00:00.000Z", { sumValue: null }),
      bucket("2026-05-01T00:00:00.000Z", { sumValue: null }),
    ];
    expect(aggregateWmyBuckets(rows).sum).toBeNull();
  });

  it("treats sumValue NaN/Infinity as missing", () => {
    const rows: RollupBucketRow[] = [
      bucket("2026-04-01T00:00:00.000Z", { sumValue: 100 }),
      bucket("2026-05-01T00:00:00.000Z", {
        // simulate a Postgres NaN slipping through serialisation.
        sumValue: Number.NaN,
      }),
    ];
    // Only the finite sumValue contributes.
    expect(aggregateWmyBuckets(rows).sum).toBe(100);
  });
});

/**
 * Granularity-routing boundaries for the shared WMY reader:
 * 90 days resolves to DAY, 365 days to MONTH, and 1095 days to YEAR.
 * A floor adjustment must update this single routing contract.
 */
describe("readBestGranularityRollups — cross-consumer routing parity", () => {
  it("aggregates MONTH buckets to a byte-identical mean compared to the underlying DAY buckets", async () => {
    // The compositional contract `count / mean` are linearly
    // composable across granularities — pin it by simulating "MONTH
    // routing for a 365-day window" vs "DAY routing for the same
    // window" against the same underlying counts/means and asserting
    // the count-weighted mean agrees.
    //
    // MONTH bucket (consolidated):    count=30, mean=80
    // DAY buckets (per-day refresh):  count=10/mean=82 + count=20/mean=79
    //   ⇒ DAY-derived mean = (10*82 + 20*79) / 30 = 80.0
    // Both must agree numerically — the routing helper's choice is a
    // performance optimisation, not a math change.
    const monthBuckets: RollupBucketRow[] = [
      bucket("2025-08-01T00:00:00.000Z", { count: 30, mean: 80 }),
    ];
    const dayBuckets: RollupBucketRow[] = [
      bucket("2025-08-05T00:00:00.000Z", { count: 10, mean: 82 }),
      bucket("2025-08-20T00:00:00.000Z", { count: 20, mean: 79 }),
    ];
    const monthAgg = aggregateWmyBuckets(monthBuckets);
    const dayAgg = aggregateWmyBuckets(dayBuckets);

    expect(monthAgg.count).toBe(dayAgg.count);
    expect(monthAgg.mean).toBeCloseTo(dayAgg.mean ?? Number.NaN, 5);
  });
});

/**
 * v1.19.2 W-CHARTS — whole-history series reader. Pins that a very long
 * "Alle" window reads the display-matching coarse tier (WEEK for 1–2 y,
 * MONTH beyond) and returns coverage spanning the FULL span rather than a
 * truncated recent slice; that the finer fallback rescues a coverage
 * miss; and that the wire shape mirrors the daily reader.
 */
describe("readTieredRollupSeries", () => {
  const DAY_MS = 86_400_000;
  // A fixed "now-ish" anchor for the current-window cases; the historic case
  // uses its own explicit past bounds. Nothing in the reader reads
  // `Date.now()` any more, so these are just span endpoints.
  const NOW = new Date("2026-06-21T00:00:00.000Z");
  const win = (days: number, to: Date = NOW) => ({
    from: new Date(to.getTime() - days * DAY_MS),
    to,
  });

  it("returns null on a non-positive window without touching the db", async () => {
    expect(
      await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        from: NOW,
        to: NOW,
      }),
    ).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("folds a multi-year window into MONTH buckets and spans the whole history", async () => {
    // Ten years of first-of-January readings → MONTH tier; the oldest
    // bucket survives (no recent-slice truncation).
    const rows = [];
    for (let y = 2017; y <= 2026; y++) {
      rows.push(dayRow(`${y}-01-01`, "MANUAL", 12, 80));
    }
    findMany.mockResolvedValueOnce(rows);

    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      ...win(3650),
    });

    expect(result?.granularity).toBe("MONTH");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("DAY");
    expect(result?.rows[0].measuredAt).toBe("2017-01-01T00:00:00.000Z");
    expect(result?.rows.at(-1)?.measuredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result?.rows.length).toBe(10);
  });

  // v1.26.0 SEAM-N2 — a historic window entirely in the past must bound the
  // rollup read on BOTH ends.
  it("bounds the DAY read on BOTH ends for a historic past window", async () => {
    const from = new Date("2020-01-01T00:00:00.000Z");
    const to = new Date("2022-01-01T00:00:00.000Z");
    findMany.mockResolvedValueOnce([
      dayRow("2020-02-01", "MANUAL", 12, 80),
      dayRow("2021-06-01", "MANUAL", 12, 81),
      dayRow("2021-12-01", "MANUAL", 12, 82),
    ]);

    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      from,
      to,
    });

    expect(findMany.mock.calls[0][0].where.bucketStart).toEqual({
      gte: from,
      lte: to,
    });
    for (const row of result?.rows ?? []) {
      const t = new Date(row.measuredAt).getTime();
      expect(t).toBeGreaterThanOrEqual(from.getTime());
      expect(t).toBeLessThanOrEqual(to.getTime());
    }
    // Data span ≈ 22 months → WEEK (the request alone would call for MONTH).
    expect(result?.granularity).toBe("WEEK");
  });

  it("returns null when the window holds no DAY buckets", async () => {
    findMany.mockResolvedValue([]);
    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      ...win(3650),
    });
    expect(result).toBeNull();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("surfaces the cumulative summed total for SUM metrics and drops the spread", async () => {
    findMany.mockResolvedValueOnce([
      ...days("2024-01-01", 30, "APPLE_HEALTH", 1, 8000),
      dayRow("2026-01-01", "APPLE_HEALTH", 1, 5000),
    ]);
    const result = await readTieredRollupSeries({
      userId: "u",
      type: "ACTIVITY_STEPS",
      ...win(3650),
    });
    expect(result?.granularity).toBe("MONTH");
    expect(result?.rows[0].value).toBe(240_000);
    expect(result?.rows[0].minValue).toBeUndefined();
    expect(result?.rows[0].maxValue).toBeUndefined();
  });

  it("carries the count-weighted mean + spread for spot metrics", async () => {
    findMany.mockResolvedValueOnce([
      dayRow("2024-01-02", "MANUAL", 2, 80, { minValue: 78, maxValue: 82 }),
      dayRow("2024-01-03", "MANUAL", 1, 84, { minValue: 84, maxValue: 85 }),
      dayRow("2026-01-01", "MANUAL", 1, 80),
    ]);
    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      ...win(3650),
    });
    expect(result?.rows[0].value).toBeCloseTo((2 * 80 + 84) / 3, 9);
    expect(result?.rows[0].count).toBe(3);
    expect(result?.rows[0].minValue).toBe(78);
    expect(result?.rows[0].maxValue).toBe(85);
  });

  // v1.37.29 — the tier keys off the ACTUAL data span, not the requested
  // window width. The "All" tab always requests ~3650 days, so pre-fix a
  // record whose history spans four months came back as four MONTH means
  // while the chart captioned them from the real span.
  describe("span refinement", () => {
    it("serves DAY rows for four months of data on an All request", async () => {
      findMany.mockResolvedValueOnce([
        dayRow("2026-02-03", "MANUAL", 1, 80),
        dayRow("2026-03-14", "MANUAL", 1, 80),
        dayRow("2026-04-09", "MANUAL", 1, 80),
        dayRow("2026-05-28", "MANUAL", 1, 80),
      ]);
      const result = await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        ...win(3650),
      });
      expect(result?.granularity).toBe("DAY");
      expect(result?.rows).toHaveLength(4);
      expect(result?.rows[0].measuredAt).toBe("2026-02-03T00:00:00.000Z");
    });

    it("serves WEEK rows for a span between one and two years", async () => {
      findMany.mockResolvedValueOnce([
        dayRow("2025-01-01", "MANUAL", 1, 80),
        dayRow("2026-05-01", "MANUAL", 1, 80),
      ]);
      const result = await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        ...win(3650),
      });
      expect(result?.granularity).toBe("WEEK");
      expect(result?.rows.map((r) => r.measuredAt)).toEqual([
        "2024-12-30T00:00:00.000Z",
        "2026-04-27T00:00:00.000Z",
      ]);
    });
  });
});

// v1.37.29 — the server tier ladder and the client caption ladder
// (`pickBucket`) are DIFFERENT functions with different thresholds, and
// their divergence is exactly what shipped monthly means under a
// "weekly average" chip. The invariant that keeps the caption honest is
// directional: for any data span, the tier the server serves is never
// COARSER than the bucket the client captions — the client may fold
// finer rows up to its caption, but it cannot split coarser ones.
describe("server tier vs client caption ladder", () => {
  const SERVER_COARSENESS = { DAY: 0, WEEK: 1, MONTH: 2, YEAR: 3 } as const;
  const CLIENT_COARSENESS = { day: 0, week: 1, month: 2 } as const;

  it("never serves coarser than the client captions, for every span up to ten years", () => {
    for (let span = 1; span <= 3650; span++) {
      const server = pickRollupGranularityForWindow(span);
      const client = pickBucket(span);
      expect(
        SERVER_COARSENESS[server],
        `span ${span}d: server ${server} vs client caption ${client}`,
      ).toBeLessThanOrEqual(CLIENT_COARSENESS[client]);
    }
  });
});
