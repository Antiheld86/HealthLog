/**
 * v1.4.39 W-WMY — unit tests for the WEEK / MONTH / YEAR rollup
 * readers and the auto-router that picks the largest granularity
 * that still resolves a requested window.
 *
 * `prisma.measurementRollup.findMany` is mocked at the module level
 * so the test pins:
 *   - each per-granularity reader filters by the correct
 *     `granularity` literal,
 *   - empty rollups return `null` so the caller can branch on
 *     coverage miss,
 *   - the auto-router walks YEAR → MONTH → WEEK → DAY and stops at
 *     the first granularity whose floor the window clears AND which
 *     has coverage,
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

describe("readBestGranularityRollups", () => {
  it("returns null on a non-positive window", async () => {
    expect(await readBestGranularityRollups("user", "WEIGHT", 0)).toBeNull();
    expect(await readBestGranularityRollups("user", "WEIGHT", -10)).toBeNull();
    expect(await readBestGranularityRollups("user", "WEIGHT", NaN)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("routes a 90-day window to DAY (every coarser floor is too low)", async () => {
    findMany.mockResolvedValueOnce([bucket("2026-04-01T00:00:00.000Z")]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 90);
    expect(result).not.toBeNull();
    expect(result?.granularity).toBe("DAY");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("DAY");
  });

  it("routes a 365-day window to MONTH (clears the 62-day MONTH floor)", async () => {
    findMany.mockResolvedValueOnce([bucket("2026-01-01T00:00:00.000Z")]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 365);
    expect(result).not.toBeNull();
    expect(result?.granularity).toBe("MONTH");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("MONTH");
  });

  it("routes a 1095-day window to YEAR (clears the 730-day YEAR floor)", async () => {
    findMany.mockResolvedValueOnce([bucket("2024-01-01T00:00:00.000Z")]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 1095);
    expect(result).not.toBeNull();
    expect(result?.granularity).toBe("YEAR");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("YEAR");
  });

  it("falls back to MONTH when YEAR has no coverage", async () => {
    // 1095-day window asks for YEAR first; coverage miss → MONTH.
    findMany
      .mockResolvedValueOnce([]) // YEAR miss
      .mockResolvedValueOnce([bucket("2024-01-01T00:00:00.000Z")]); // MONTH hit

    const result = await readBestGranularityRollups("user", "WEIGHT", 1095);

    expect(result?.granularity).toBe("MONTH");
    expect(findMany.mock.calls[0][0].where.granularity).toBe("YEAR");
    expect(findMany.mock.calls[1][0].where.granularity).toBe("MONTH");
  });

  it("falls all the way through to DAY when every coarser tier misses", async () => {
    findMany
      .mockResolvedValueOnce([]) // YEAR miss
      .mockResolvedValueOnce([]) // MONTH miss
      .mockResolvedValueOnce([]) // WEEK miss
      .mockResolvedValueOnce([bucket("2024-01-01T00:00:00.000Z")]); // DAY hit

    const result = await readBestGranularityRollups("user", "WEIGHT", 1095);

    expect(result?.granularity).toBe("DAY");
    expect(findMany).toHaveBeenCalledTimes(4);
  });

  it("returns null when no granularity carries any coverage", async () => {
    findMany.mockResolvedValue([]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 1095);
    expect(result).toBeNull();
    // YEAR, MONTH, WEEK, DAY all probed.
    expect(findMany).toHaveBeenCalledTimes(4);
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
  it("pins the 90 / 365 / 1095 day routing targets the consumers depend on", async () => {
    // Three sequential probes with non-empty results so the router
    // stops at the first matching tier per window.
    findMany
      .mockResolvedValueOnce([bucket("2026-02-15T00:00:00.000Z")]) // 90d → DAY
      .mockResolvedValueOnce([bucket("2025-08-01T00:00:00.000Z")]) // 365d → MONTH
      .mockResolvedValueOnce([bucket("2024-01-01T00:00:00.000Z")]); // 1095d → YEAR

    const ninety = await readBestGranularityRollups("user", "WEIGHT", 90);
    const yearLong = await readBestGranularityRollups("user", "WEIGHT", 365);
    const threeYear = await readBestGranularityRollups("user", "WEIGHT", 1095);

    expect(ninety?.granularity).toBe("DAY");
    expect(yearLong?.granularity).toBe("MONTH");
    expect(threeYear?.granularity).toBe("YEAR");
    // Each consumer-relevant window only fires one round-trip on the
    // happy path; the per-tier walk is reserved for coverage-miss
    // scenarios already pinned above.
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("DAY");
    expect(findMany.mock.calls[1][0].where.granularity).toBe("MONTH");
    expect(findMany.mock.calls[2][0].where.granularity).toBe("YEAR");
  });

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

  it("reads the MONTH tier for a multi-year window and spans the whole history", async () => {
    // 10-year window → MONTH tier. The fixture carries buckets from the
    // OLDEST month through the most recent — the result must keep the
    // oldest bucket, proving no recent-slice truncation.
    const months: RollupBucketRow[] = [];
    for (let y = 2017; y <= 2026; y++) {
      months.push(bucket(`${y}-01-01T00:00:00.000Z`, { count: 12, mean: 80 }));
    }
    findMany.mockResolvedValueOnce(months);

    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      ...win(3650),
    });

    expect(result).not.toBeNull();
    expect(result?.granularity).toBe("MONTH");
    expect(findMany.mock.calls[0][0].where.granularity).toBe("MONTH");
    // Whole-history coverage: the earliest 2017 bucket survives.
    expect(result?.rows[0].measuredAt).toBe("2017-01-01T00:00:00.000Z");
    expect(result?.rows.at(-1)?.measuredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result?.rows.length).toBe(10);
  });

  // v1.26.0 SEAM-N2 — a historic window entirely in the past must bound the
  // rollup read on BOTH ends. Pre-fix the reader anchored on `now − windowDays`
  // and would have queried `bucketStart >= now − 730d` (mid-2024 onward),
  // returning recent buckets for a 2020–2022 ask.
  it("bounds the rollup read on BOTH ends for a historic past window", async () => {
    const from = new Date("2020-01-01T00:00:00.000Z");
    const to = new Date("2022-01-01T00:00:00.000Z");
    const inWindow: RollupBucketRow[] = [
      bucket("2020-02-01T00:00:00.000Z", { count: 12, mean: 80 }),
      bucket("2021-06-01T00:00:00.000Z", { count: 12, mean: 81 }),
      bucket("2021-12-01T00:00:00.000Z", { count: 12, mean: 82 }),
    ];
    findMany.mockResolvedValueOnce(inWindow);

    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      from,
      to,
    });

    // The `bucketStart` filter carries BOTH the requested lower AND upper
    // bound — not a trailing "to now" slice.
    const where = findMany.mock.calls[0][0].where;
    expect(where.bucketStart).toEqual({ gte: from, lte: to });
    // Every returned bucket_start falls inside the requested window.
    for (const row of result?.rows ?? []) {
      const t = new Date(row.measuredAt).getTime();
      expect(t).toBeGreaterThanOrEqual(from.getTime());
      expect(t).toBeLessThanOrEqual(to.getTime());
    }
    // Tier width is 2 years (731 days) → still the MONTH tier for >730 d.
    expect(result?.granularity).toBe("MONTH");
  });

  // The web-chart "All" path passes `to ≈ now`; prove that case still bounds
  // on both ends (no regression) — the historic fix must not perturb it.
  it("bounds a current-window (to = now) read on both ends too", async () => {
    findMany.mockResolvedValueOnce([bucket("2026-01-01T00:00:00.000Z")]);
    const { from, to } = win(3650);
    await readTieredRollupSeries({ userId: "u", type: "WEIGHT", from, to });
    expect(findMany.mock.calls[0][0].where.bucketStart).toEqual({
      gte: from,
      lte: to,
    });
  });

  it("reads the WEEK tier for a 1–2 year window", async () => {
    findMany.mockResolvedValueOnce([bucket("2025-08-04T00:00:00.000Z")]);
    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      ...win(540),
    });
    expect(result?.granularity).toBe("WEEK");
    expect(findMany.mock.calls[0][0].where.granularity).toBe("WEEK");
  });

  it("falls FINER (MONTH → WEEK → DAY) when the target tier has no coverage", async () => {
    findMany
      .mockResolvedValueOnce([]) // MONTH miss
      .mockResolvedValueOnce([]) // WEEK miss
      .mockResolvedValueOnce([bucket("2024-03-01T00:00:00.000Z")]); // DAY hit
    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      ...win(3650),
    });
    expect(result?.granularity).toBe("DAY");
    expect(findMany.mock.calls[0][0].where.granularity).toBe("MONTH");
    expect(findMany.mock.calls[1][0].where.granularity).toBe("WEEK");
    expect(findMany.mock.calls[2][0].where.granularity).toBe("DAY");
  });

  it("returns null when no tier at or below the target carries coverage", async () => {
    findMany.mockResolvedValue([]);
    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      ...win(3650),
    });
    expect(result).toBeNull();
    // MONTH, WEEK, DAY all probed (never coarser than the target).
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("surfaces the cumulative summed total for SUM metrics and drops the spread", async () => {
    findMany.mockResolvedValueOnce([
      bucket("2025-01-01T00:00:00.000Z", {
        count: 30,
        mean: 8000,
        sumValue: 240_000,
        minValue: 0,
        maxValue: 20_000,
      }),
    ]);
    const result = await readTieredRollupSeries({
      userId: "u",
      type: "ACTIVITY_STEPS",
      ...win(3650),
    });
    expect(result?.rows[0].value).toBe(240_000);
    expect(result?.rows[0].minValue).toBeUndefined();
    expect(result?.rows[0].maxValue).toBeUndefined();
  });

  it("carries the count-weighted mean + spread for spot metrics", async () => {
    findMany.mockResolvedValueOnce([
      bucket("2025-01-01T00:00:00.000Z", {
        count: 12,
        mean: 81.5,
        minValue: 78,
        maxValue: 85,
      }),
    ]);
    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      ...win(3650),
    });
    expect(result?.rows[0].value).toBe(81.5);
    expect(result?.rows[0].minValue).toBe(78);
    expect(result?.rows[0].maxValue).toBe(85);
  });

  // v1.37.29 — the tier keys off the ACTUAL data span, not the requested
  // window width. The "All" tab always requests ~3650 days, so pre-fix a
  // record whose history spans four months came back as four MONTH means
  // while the chart captioned them from the real span — "weekly average"
  // over monthly buckets.
  describe("span refinement", () => {
    it("re-reads at the tier the real span calls for (4 months of data on an All request → DAY)", async () => {
      const months = [
        bucket("2026-02-01T00:00:00.000Z"),
        bucket("2026-03-01T00:00:00.000Z"),
        bucket("2026-04-01T00:00:00.000Z"),
        bucket("2026-05-01T00:00:00.000Z"),
      ];
      const days = [
        bucket("2026-02-03T00:00:00.000Z"),
        bucket("2026-03-14T00:00:00.000Z"),
        bucket("2026-04-09T00:00:00.000Z"),
        bucket("2026-05-28T00:00:00.000Z"),
      ];
      findMany.mockResolvedValueOnce(months).mockResolvedValueOnce(days);

      const result = await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        ...win(3650),
      });

      // Span of the MONTH rows ≈ 89 days → the display ladder wants DAY,
      // and the refinement jumps straight there (no WEEK stop-over).
      expect(findMany.mock.calls[0][0].where.granularity).toBe("MONTH");
      expect(findMany.mock.calls[1][0].where.granularity).toBe("DAY");
      expect(findMany).toHaveBeenCalledTimes(2);
      expect(result?.granularity).toBe("DAY");
      expect(result?.rows).toHaveLength(4);
      expect(result?.rows[0].measuredAt).toBe("2026-02-03T00:00:00.000Z");
    });

    it("refines to WEEK for a span between one and two years", async () => {
      const months = [
        bucket("2025-01-01T00:00:00.000Z"),
        bucket("2026-05-01T00:00:00.000Z"),
      ];
      const weeks = [
        bucket("2024-12-30T00:00:00.000Z"),
        bucket("2026-04-27T00:00:00.000Z"),
      ];
      findMany.mockResolvedValueOnce(months).mockResolvedValueOnce(weeks);

      const result = await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        ...win(3650),
      });

      expect(findMany.mock.calls[1][0].where.granularity).toBe("WEEK");
      expect(result?.granularity).toBe("WEEK");
    });

    it("keeps the coarser rows when the finer tier has no coverage", async () => {
      const months = [
        bucket("2026-01-01T00:00:00.000Z"),
        bucket("2026-05-01T00:00:00.000Z"),
      ];
      findMany.mockResolvedValueOnce(months).mockResolvedValueOnce([]);

      const result = await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        ...win(3650),
      });

      expect(result?.granularity).toBe("MONTH");
      expect(result?.rows).toHaveLength(2);
    });

    it("does not probe when the rows already span the requested tier", async () => {
      const months = [
        bucket("2018-01-01T00:00:00.000Z"),
        bucket("2026-05-01T00:00:00.000Z"),
      ];
      findMany.mockResolvedValueOnce(months);

      const result = await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        ...win(3650),
      });

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(result?.granularity).toBe("MONTH");
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
