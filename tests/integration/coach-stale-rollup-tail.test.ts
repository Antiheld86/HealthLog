/**
 * CHARACTERISATION — a rollup bucket outlives the rows it was folded from, and
 * the Coach is shown the result without any marker saying so.
 *
 * The read-swap in `tiered-context.ts` falls back to live SQL only when a band
 * is EMPTY (`if (buckets.length > 0) return buckets;`), so a bucket that is
 * merely wrong is served as though it were current. The one staleness repair,
 * `ensureUserRollupsFresh`, recomputes the DAY tier over the trailing 90 days
 * only, and keys off `Measurement.updatedAt` — which a HARD delete does not
 * bump. `src/lib/whoop/sync-body.ts` performs exactly such a hard
 * `measurement.deleteMany` on a WEIGHT row with no rollup invalidation, so this
 * reproduces that shape against a MONTH-band bucket.
 *
 * What this pins, in the snapshot the Coach narrates from:
 *   - `weight.timeline.coarse.monthly` still carries the deleted value;
 *   - `weight.aggregate.allTimeMin/Max` correctly carry only the surviving
 *     value, so the snapshot contradicts itself and nothing flags which half
 *     is right;
 *   - `weight.asOf.currentForTodayClaims` is true, because `asOf` is derived
 *     from the freshest RAW reading and knows nothing about rollup age.
 *
 * This asserts CURRENT behaviour. Closing the gap — comparing bucket
 * `computedAt` against the type's in-window `MAX(measurement.updatedAt)`, or
 * invalidating on the hard delete — will redden it, and the assertions should
 * then be flipped to the honest expectation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

const prisma = getPrismaClient();
const DAY = 24 * 60 * 60 * 1000;

/** The value only ever present in the rows we delete. */
const GHOST_KG = 95;
/** The value the record still holds afterwards. */
const LIVE_KG = 80;

interface WeightBlock {
  aggregate: { allTimeMin: number; allTimeMax: number };
  timeline: { coarse?: { monthly: Array<[string, number, number, number]> } };
  asOf: { currentForTodayClaims: boolean };
}

describe("coach snapshot — a rollup bucket that outlived its rows", () => {
  beforeEach(async () => {
    await truncateAllTables(prisma);
  });

  it("serves the deleted value in the coarse tail while claiming the block is current", async () => {
    const user = await prisma.user.create({
      data: {
        email: "stale-rollup@example.test",
        username: "stale-rollup",
        passwordHash: "x",
      },
    });
    const userId = user.id;

    // Rows in the MONTH band (90 days to a year), plus recent rows so the
    // snapshot renders a weight block at all.
    await prisma.measurement.createMany({
      data: [
        ...Array.from({ length: 12 }, (_, i) => ({
          userId,
          type: "WEIGHT" as const,
          value: GHOST_KG,
          unit: "kg",
          source: "WHOOP" as const,
          externalId: `stale-${i}`,
          measuredAt: new Date(Date.now() - (200 + i) * DAY),
        })),
        ...Array.from({ length: 6 }, (_, i) => ({
          userId,
          type: "WEIGHT" as const,
          value: LIVE_KG,
          unit: "kg",
          measuredAt: new Date(Date.now() - i * DAY),
        })),
      ],
    });

    await recomputeUserRollups(userId);

    // The hard delete `whoop/sync-body.ts` performs — no rollup invalidation,
    // and no `updatedAt` bump for the freshness probe to notice.
    const deleted = await prisma.measurement.deleteMany({
      where: { userId, type: "WEIGHT", source: "WHOOP" },
    });
    expect(deleted.count).toBe(12);

    const remaining = await prisma.measurement.findMany({
      where: { userId, type: "WEIGHT" },
      select: { value: true },
    });
    expect(remaining.every((r) => r.value === LIVE_KG)).toBe(true);

    // The MONTH buckets are untouched by the delete.
    const buckets = await prisma.measurementRollup.findMany({
      where: { userId, type: "WEIGHT", granularity: "MONTH", source: "WHOOP" },
      select: { mean: true, count: true },
    });
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.every((b) => b.mean === GHOST_KG)).toBe(true);

    const snap = await buildCoachSnapshot(userId);
    const weight = (snap.sections as Record<string, unknown>)
      .weight as WeightBlock;

    // The coarse tail the Coach narrates still reports the deleted value.
    const monthly = weight.timeline.coarse?.monthly ?? [];
    expect(monthly.length).toBeGreaterThan(0);
    expect(monthly.every((row) => row[1] === GHOST_KG)).toBe(true);
    expect(snap.snapshotJson).toContain(String(GHOST_KG));

    // …while the all-time extremes, read live, know only the surviving value.
    expect(weight.aggregate.allTimeMin).toBe(LIVE_KG);
    expect(weight.aggregate.allTimeMax).toBe(LIVE_KG);

    // …and the block is stamped current, which licenses present-tense prose.
    expect(weight.asOf.currentForTodayClaims).toBe(true);
  });
});
