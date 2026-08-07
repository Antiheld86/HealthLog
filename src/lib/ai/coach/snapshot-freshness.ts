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

/**
 * Attach `asOf` to every snapshot block whose aggregate reports a freshest
 * reading. Blocks with no coverage (narrative memory, plans, the reference
 * grounding table) are untouched — they carry no measurement to date.
 *
 * Returns the metric keys that were stamped stale, so the caller can annotate
 * them: a briefing narrated off a week-old series is worth seeing in the wide
 * event, not just in the reader's confusion.
 */
export function annotateSnapshotFreshness(
  snapshot: Record<string, unknown>,
): string[] {
  const stale: string[] = [];
  for (const [key, block] of Object.entries(snapshot)) {
    const daysAgo = readNewestDaysAgo(block);
    if (daysAgo === null) continue;
    const asOf = asOfFromDaysAgo(daysAgo);
    (block as Record<string, unknown>).asOf = asOf;
    if (!asOf.currentForTodayClaims) stale.push(key);
  }
  return stale;
}

export { TODAY_CLAIM_MAX_AGE_DAYS };
