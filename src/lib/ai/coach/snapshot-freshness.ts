/**
 * Stamp every metric block in the Coach snapshot with the age of its freshest
 * reading.
 *
 * The narrated surfaces — the dashboard hero line, the daily briefing, the
 * Coach reply — are written from this snapshot. Each metric block carried its
 * aggregates and a dated timeline, and nothing else: no statement of when the
 * series actually ends. Reading it, the newest row looks like now, and the
 * prose came out as "your pulse is well above your 30-day average today" on a
 * day whose pulse had not been measured for the better part of a week.
 *
 * The age was already in the block, buried one level down in the coverage
 * object as `newestDaysAgo`, where it read as a statistics footnote rather
 * than as the fact that governs the tense of every sentence about the metric.
 * This lifts it to the block's own surface and states the consequence
 * directly, so the answer arrives with the data instead of depending on the
 * reader working it out.
 *
 * The same pass reconciles each block's coarse (MONTH / YEAR) timeline, served
 * from the rollup tier, against the all-time extremes read live beside it. The
 * read-swap falls back to live SQL only when a band is EMPTY, so a bucket whose
 * rows were hard-deleted with no invalidation keeps being served as current —
 * and the block then states two different things about the same record with
 * nothing saying which is right. A bucket mean cannot lie outside its own rows'
 * extremes, so when it does the band is dropped rather than narrated.
 *
 * Pure and in-place — the snapshot is a plain record by the time it gets here.
 */
import {
  TODAY_CLAIM_MAX_AGE_DAYS,
  isCurrentForTodayClaim,
} from "@/lib/insights/measurement-freshness";

/** When a metric block's series actually ends, and what may be said about it. */
export interface SnapshotAsOf {
  /** Whole days between the freshest reading and today. `0` is today. */
  daysAgo: number;
  /** True when the freshest reading is from today. */
  isToday: boolean;
  /**
   * False when the freshest reading is too old to back a present-tense
   * sentence. The block's numbers are still true — they are just true about
   * the day they were taken on, and must be stated with that day.
   */
  currentForTodayClaims: boolean;
  /**
   * Set when the block's coarse (MONTH / YEAR) timeline was dropped because it
   * could not be reconciled with the live record beside it. Present only in
   * that case, so its absence is the normal state and costs no prompt budget.
   */
  coarseHistoryWithheld?: true;
}

function readNewestDaysAgo(block: unknown): number | null {
  if (typeof block !== "object" || block === null) return null;
  const aggregate = (block as { aggregate?: unknown }).aggregate;
  if (typeof aggregate !== "object" || aggregate === null) return null;
  const coverage = (aggregate as { coverage?: unknown }).coverage;
  if (typeof coverage !== "object" || coverage === null) return null;
  const newestDaysAgo = (coverage as { newestDaysAgo?: unknown }).newestDaysAgo;
  return typeof newestDaysAgo === "number" && Number.isFinite(newestDaysAgo)
    ? newestDaysAgo
    : null;
}

/**
 * Build the `asOf` stamp for one reading age. Exported so the rule is testable
 * without assembling a snapshot.
 */
export function asOfFromDaysAgo(daysAgo: number): SnapshotAsOf {
  return {
    daysAgo,
    isToday: daysAgo === 0,
    currentForTodayClaims: isCurrentForTodayClaim(daysAgo),
  };
}

/** Coarse-band bucket rows are `[bucketStart, mean, min, max]`. */
type CoarseBucket = [string, number, number, number];

/** Rounding headroom, so a float artefact is never read as a contradiction. */
const RECONCILE_EPSILON = 1e-6;

function readAllTimeExtremes(
  block: unknown,
): { min: number; max: number } | null {
  if (typeof block !== "object" || block === null) return null;
  const aggregate = (block as { aggregate?: unknown }).aggregate;
  if (typeof aggregate !== "object" || aggregate === null) return null;
  const min = (aggregate as { allTimeMin?: unknown }).allTimeMin;
  const max = (aggregate as { allTimeMax?: unknown }).allTimeMax;
  if (typeof min !== "number" || !Number.isFinite(min)) return null;
  if (typeof max !== "number" || !Number.isFinite(max)) return null;
  return { min, max };
}

function readCoarse(block: unknown): Record<string, unknown> | null {
  if (typeof block !== "object" || block === null) return null;
  const timeline = (block as { timeline?: unknown }).timeline;
  if (typeof timeline !== "object" || timeline === null) return null;
  const coarse = (timeline as { coarse?: unknown }).coarse;
  if (typeof coarse !== "object" || coarse === null) return null;
  return coarse as Record<string, unknown>;
}

function bucketsOf(coarse: Record<string, unknown>, band: string): number[] {
  const rows = coarse[band];
  if (!Array.isArray(rows)) return [];
  return (rows as CoarseBucket[])
    .map((row) => (Array.isArray(row) ? row[1] : Number.NaN))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/**
 * Decide whether a block's coarse timeline can be reconciled with the live
 * record it sits beside.
 *
 * The coarse MONTH / YEAR bands are served from the rollup tier; the aggregate's
 * all-time extremes are read live. A bucket mean is an average of real rows, so
 * it MUST lie within the all-time min/max of those same rows. When it does not,
 * the rollup is describing readings the live read cannot see — the bucket
 * outlived the rows it was folded from.
 *
 * This is an invariant, not a heuristic: no arrangement of existing rows can
 * average to a value outside their own extremes.
 */
function coarseContradictsRecord(block: unknown): boolean {
  const extremes = readAllTimeExtremes(block);
  if (extremes === null) return false;
  const coarse = readCoarse(block);
  if (coarse === null) return false;
  const means = [
    ...bucketsOf(coarse, "monthly"),
    ...bucketsOf(coarse, "yearly"),
  ];
  if (means.length === 0) return false;
  return means.some(
    (mean) =>
      mean < extremes.min - RECONCILE_EPSILON ||
      mean > extremes.max + RECONCILE_EPSILON,
  );
}

/**
 * Attach `asOf` to every snapshot block whose aggregate reports a freshest
 * reading. Blocks with no coverage (narrative memory, plans, the reference
 * grounding table) are untouched — they carry no measurement to date.
 *
 * Also drops a coarse timeline that contradicts the live record beside it. The
 * rollup tier's read-swap falls back to live SQL only when a band is EMPTY, so
 * a bucket that is merely WRONG — the rows behind it deleted, and no
 * invalidation fired — is served as though it were current. The block then
 * carried two irreconcilable accounts of the same record (a coarse tail saying
 * one thing, all-time extremes saying another) with nothing marking which to
 * believe, under an `asOf` stamped from raw reading age that knows nothing
 * about rollup age. Narrating a ghost is worse than narrating less, so the
 * disputed tail goes and `coarseHistoryWithheld` says it went.
 *
 * `currentForTodayClaims` stays keyed to raw recency, which is what it means:
 * the freshest READING is still as fresh as it was, and suppressing it would
 * silence a true present-tense statement to punish a stale history band.
 *
 * Returns the metric keys stamped stale and the keys whose coarse tail was
 * withheld, so the caller can annotate both: a briefing narrated off a week-old
 * series is worth seeing in the wide event, and so is a rollup that has drifted
 * away from the rows underneath it.
 */
export function annotateSnapshotFreshness(snapshot: Record<string, unknown>): {
  stale: string[];
  coarseWithheld: string[];
} {
  const stale: string[] = [];
  const coarseWithheld: string[] = [];
  for (const [key, block] of Object.entries(snapshot)) {
    const daysAgo = readNewestDaysAgo(block);
    if (daysAgo === null) continue;
    const asOf = asOfFromDaysAgo(daysAgo);
    if (coarseContradictsRecord(block)) {
      const timeline = (block as { timeline?: Record<string, unknown> })
        .timeline;
      if (timeline) delete timeline.coarse;
      asOf.coarseHistoryWithheld = true;
      coarseWithheld.push(key);
    }
    (block as Record<string, unknown>).asOf = asOf;
    if (!asOf.currentForTodayClaims) stale.push(key);
  }
  return { stale, coarseWithheld };
}

export { TODAY_CLAIM_MAX_AGE_DAYS };
