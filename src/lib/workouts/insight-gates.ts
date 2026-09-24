/**
 * The pure half of the Activity Insight gate stack.
 *
 * Five gates stand between a workout landing and a provider call, and they run
 * in this order for a reason — each one is cheaper than the one after it, so
 * the common refusals cost nothing:
 *
 *   1. capability — `workoutInsights` (both owning modules, the operator
 *      switches, provider presence and consent in one answer)
 *   2. duration — at least `MIN_DURATION_SEC` (a field already in hand)
 *   3. daily cap — at most `MAX_INSIGHTS_PER_DAY` generated today (one COUNT)
 *   4. input hash — the evidence is unchanged since the last paragraph (one
 *      indexed read, no provider resolution)
 *   5. budget — the token ledger's reserve/reconcile, inside
 *      `runStatusCompletion`
 *
 * Gates 2 and 4 are pure and live here so each can be tested on its own. The
 * other three need the database and live in the worker beside their query.
 *
 * Every one of them is a SEPARATE claim. The daily cap does not depend on the
 * hash holding, and the hash does not depend on the singleton queue key
 * holding: a device that double-posts the same session must be stopped by the
 * unique row and by the hash independently, because a queue key is a
 * best-effort de-duplication and a lost singleton race is a normal event.
 */
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import type { WorkoutInsightEvidence } from "./insight-evidence";

/**
 * The duration floor.
 *
 * Ten minutes. Below it there is nothing a paragraph can honestly say that the
 * stats row does not already say better — a four-minute walk has no zone
 * distribution, no front/back-half story and no meaningful comparison to a
 * ninety-day median. Silence is the correct output, not a padded sentence.
 */
export const MIN_DURATION_SEC = 600;

/**
 * The hard per-user daily ceiling on generated paragraphs.
 *
 * This is a COUNT of rows written today, not a rate limit: it holds even if
 * the queue keys, the unique constraint and the hash all fail at once, which
 * is exactly what a hard cap is for. Four is above any realistic training day
 * and two orders of magnitude below a device stuck in a re-post loop.
 */
export const MAX_INSIGHTS_PER_DAY = 4;

/** True when the session is long enough to describe. */
export function meetsDurationFloor(durationSec: number): boolean {
  return Number.isFinite(durationSec) && durationSec >= MIN_DURATION_SEC;
}

/**
 * Fingerprint the evidence together with the prompt version.
 *
 * `hashInsightSnapshot` canonicalises key order and drops volatile keys, so
 * two projections of the same session hash identically regardless of how the
 * object was assembled. Including the prompt version means a deliberate prompt
 * change re-opens generation exactly once per workout, while a re-sync of
 * unchanged data stays free forever.
 *
 * What is deliberately NOT in here: anything that moves on its own. No
 * timestamps, no row ids, no provider name. A hash that drifted with the clock
 * would turn the cheapest gate in the stack into a no-op.
 */
export function workoutInsightInputHash(
  evidence: WorkoutInsightEvidence,
  promptVersion: string,
): string {
  return hashInsightSnapshot({ evidence, promptVersion });
}
