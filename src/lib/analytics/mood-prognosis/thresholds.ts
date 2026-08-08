/**
 * How much history a prognosis needs before it is allowed to say anything.
 *
 * This is the most dangerous file in the feature, and it is dangerous for one
 * reason: **the failure mode is silent.** A forecast built from eight days
 * renders exactly like a forecast built from eighty. Nobody looking at the
 * screen can tell the difference, and the person reading it is being told
 * something about their own health record. So every floor is a named constant
 * with a boundary test, and every one of those tests has been watched failing
 * — a gate nobody has seen go red is a decoration, not a gate.
 *
 * The ladder has five rungs, and each rung says what the surface may claim:
 *
 * | entries | stage         | what may be shown                              |
 * |---------|---------------|------------------------------------------------|
 * | 0-14    | `insufficient`| nothing beyond the self-assessment trend        |
 * | 15-29   | `learning`    | descriptive hints, labelled as a learning phase |
 * | 30-59   | `provisional` | a forecast, labelled provisional                |
 * | 60-89   | `regular`     | a forecast without the provisional label        |
 * | 90+     | `seasonal`    | plus weekday and seasonal comparisons           |
 *
 * Absence is `{ present: false }` with a reason and the count, never `0` and
 * never an empty forecast object with a null inside it. That shape is a
 * contract elsewhere in the product already — the MCP surface means exactly
 * "honestly not recorded" by it — and a surface that answered zero here would
 * be claiming a bad day where the truth is that nothing can be said yet.
 *
 * **Two numbers are deliberately NOT minted here.** The paired-observation
 * floor for a correlation is `MIN_PAIRED_N` in
 * `src/lib/insights/correlations.ts`, and the screening in `features.ts`
 * imports it from there; a second constant for the same idea is how two
 * surfaces start disagreeing about what counts as enough. The occurrence floor
 * below is the crosstab's own floor by assignment rather than by coincidence,
 * for the same reason — Phase 2's context comparison says at its declaration
 * that this file would import it, and this file does.
 */
import { CONTEXT_MIN_PRESENT_DAYS } from "@/lib/insights/mood-context-crosstab";

/**
 * Below this, no output at all — not even a descriptive hint.
 *
 * Fifteen days of a person's life is not a pattern, and a surface that
 * described one would be describing noise back to somebody who would
 * reasonably believe it.
 */
export const MIN_ENTRIES_LEARNING_PHASE = 15;

/**
 * Below this, descriptive hints only, labelled as a learning phase. At or
 * above it, a fitted forecast is allowed.
 */
export const MIN_ENTRIES_FOR_FORECAST = 30;

/** Below this, a forecast is shown but labelled provisional. */
export const MIN_ENTRIES_FOR_REGULAR_FORECAST = 60;

/**
 * Below this, a weekday or seasonal comparison built on the forecast may not
 * be shown.
 *
 * Two things it does NOT do, both worth stating because the omission is a
 * decision rather than an oversight:
 *
 *   * It does not retro-gate the weekday board the mood insights page has
 *     carried for releases. That board is built from the entry aggregates,
 *     not from this fit, and it has its own floors; hiding it from accounts
 *     under ninety days would take a surface away from people who have been
 *     reading it, to enforce a rule about a different calculation.
 *   * It does not build a second weekday board. One exists, and a second
 *     answer to "how do your Mondays go" is exactly the drift this milestone
 *     spent its effort avoiding.
 *
 * What it does is gate the `seasonalUnlocked` flag the forecast publishes, so
 * any surface that wants to hang a weekday claim off THIS comparison — the
 * clients included — asks one place whether the history supports one.
 */
export const MIN_ENTRIES_FOR_SEASONAL = 90;

/**
 * How often a tag or a context value must have been recorded before it may
 * appear in an explanation at all.
 *
 * The crosstab's floor, taken rather than re-declared: it is the same
 * question ("has this been seen often enough to be worth a sentence") asked
 * by a different surface, and two answers to it would drift.
 */
export const MIN_TAG_OCCURRENCES = CONTEXT_MIN_PRESENT_DAYS;

// A per-weekday observation floor was drafted here for a weekday-comparison
// board built on the forecast. That board was not built — the forecast
// publishes `seasonalUnlocked` and leaves the weekday view to the mood
// insights page, which has its own floors — so the constant had no consumer
// and was removed rather than left as a number nothing reads. If a weekday
// comparison on THIS fit is ever built, reintroduce the floor with it.

/** Where an account sits on the ladder. */
export type PrognosisStage =
  "insufficient" | "learning" | "provisional" | "regular" | "seasonal";

/**
 * Why there is no forecast. The reason travels with the count and with the
 * next rung, so a surface can say "eleven of fifteen" instead of an error.
 */
export type PrognosisAbsenceReason = "no-output-yet" | "learning-phase";

export interface PrognosisAbsent {
  present: false;
  reason: PrognosisAbsenceReason;
  stage: Extract<PrognosisStage, "insufficient" | "learning">;
  /** Qualifying entries the account has. */
  entries: number;
  /** Entries at which the next thing becomes available. */
  nextThreshold: number;
}

export interface PrognosisAvailable {
  present: true;
  stage: Extract<PrognosisStage, "provisional" | "regular" | "seasonal">;
  entries: number;
  /** The forecast carries a provisional label below the regular threshold. */
  provisional: boolean;
}

export type PrognosisGate = PrognosisAbsent | PrognosisAvailable;

/**
 * Which rung this many qualifying entries reaches.
 *
 * Every comparison is `>=`, so the constant names the first value that
 * qualifies rather than the last that does not. The boundary tests pin both
 * sides of each one.
 */
export function prognosisStage(entries: number): PrognosisStage {
  if (entries >= MIN_ENTRIES_FOR_SEASONAL) return "seasonal";
  if (entries >= MIN_ENTRIES_FOR_REGULAR_FORECAST) return "regular";
  if (entries >= MIN_ENTRIES_FOR_FORECAST) return "provisional";
  if (entries >= MIN_ENTRIES_LEARNING_PHASE) return "learning";
  return "insufficient";
}

/**
 * Whether a forecast may be shown for an account with this many qualifying
 * entries, and if not, why not and what would change it.
 */
export function forecastGate(entries: number): PrognosisGate {
  const stage = prognosisStage(entries);
  if (stage === "insufficient") {
    return {
      present: false,
      reason: "no-output-yet",
      stage,
      entries,
      nextThreshold: MIN_ENTRIES_LEARNING_PHASE,
    };
  }
  if (stage === "learning") {
    return {
      present: false,
      reason: "learning-phase",
      stage,
      entries,
      nextThreshold: MIN_ENTRIES_FOR_FORECAST,
    };
  }
  return {
    present: true,
    stage,
    entries,
    provisional: stage === "provisional",
  };
}

/** Whether weekday and seasonal comparisons have unlocked for this account. */
export function seasonalComparisonsUnlocked(entries: number): boolean {
  return entries >= MIN_ENTRIES_FOR_SEASONAL;
}

/** Whether a tag or context value has been recorded often enough to name. */
export function occurrencesSuffice(occurrences: number): boolean {
  return occurrences >= MIN_TAG_OCCURRENCES;
}
