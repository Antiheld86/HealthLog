/**
 * v1.17 W1b — single Health-Score BP-pillar input builder.
 *
 * The Personal Health Score is computed by `computeUserHealthScoreFastPath`
 * from two server callers: the analytics route (the Insights health-score
 * card) and the dashboard snapshot (the hero ring). Before this builder the
 * two callers assembled the BP-pillar inputs by hand and DIVERGED:
 *
 *   - the analytics route fed the BP pillar from the all-time in-target rate
 *     and passed the prior-week values for the week-over-week delta;
 *   - the dashboard snapshot fed the pillar from the trailing-30-day rate and
 *     omitted the prior-week values entirely (so the ring's delta zeroed BP
 *     out and the pillar's presence gate flipped on a user with BP history
 *     but no readings in the last month).
 *
 * Same user, two different scores and two different bands. v1.17 W1d already
 * unified the WINDOW (both read the trailing-90-day rate); this builder
 * unifies the ASSEMBLY so the window choice, the all-time fallback, the
 * graded-score wiring and the prior-week delta inputs can never drift between
 * the two surfaces again. Both callers pass the identical
 * `BpInTargetEnvelope` pair through here and consume the result verbatim.
 *
 * v1.34 — the WEIGHT yardstick joins the file for the same reason. The score
 * used to grade weight against `22 × height²` ± 2 kg: a target no user ever
 * set and no surface ever named. `buildHealthScoreWeightTarget` replaces it
 * with the one honest source, `getEffectiveRange("WEIGHT", …)`, and hands the
 * band over ONLY when it is a real user override. Both callers route through
 * it so the ring and the card can never grade weight against two different
 * yardsticks.
 *
 * Pure & deterministic — no I/O. The callers own the
 * `computeBpInTargetFastPath` reads (current + prior-week) and hand the two
 * envelopes in, and own the `User` row the weight profile / overrides come
 * from.
 */
import type { BpInTargetEnvelope } from "./bp-in-target-fast-path";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
  type UserProfileForRange,
} from "./effective-range";
import type { WeightTargetSource } from "./health-score";
import { isWindowSufficient } from "./window-confidence";

/**
 * The BP-pillar slice of `HealthScoreFastPathInput`. Both Health-Score
 * callers spread this into their `computeUserHealthScoreFastPath` call so the
 * pillar is graded off identical inputs regardless of surface.
 */
export interface HealthScoreBpInputs {
  bpInTargetPct: number | null;
  bpInTargetPctPriorWeek: number | null;
  bpGradedScore: number | null;
  bpGradedScorePriorWeek: number | null;
}

/**
 * Build the BP-pillar inputs from the current-window and prior-week
 * `computeBpInTargetFastPath` envelopes.
 *
 * - The pillar rate (presence gate + secondary stat) reads the canonical
 *   trailing-90-day window (W1d), falling back to the all-time rate only when
 *   the 90-day window is itself null so a sparse-but-historical account keeps
 *   its BP pillar.
 * - v1.17 W1b — when the 90-day window holds fewer than the confidence floor
 *   (`isWindowSufficient`) the pillar collapses to `null` so a thin-data user
 *   does not get a confident BP pillar grading off a handful of readings. The
 *   dashboard tile shows "collecting data" for the same input; the pillar and
 *   the tile agree on the gate. The all-time fallback still rescues an account
 *   with a deep history but a quiet last quarter.
 * - The prior-week rate uses the prior-week run's 90-day window so the
 *   week-over-week delta compares the same window on both ends.
 * - The graded clinical-proximity score (the pillar VALUE) and its prior-week
 *   counterpart come straight off the envelopes.
 *
 * `null` for the current envelope (no BP targets / no readings) collapses
 * every field to `null`, which the score helper reads as "pillar absent".
 */
export function buildHealthScoreBpInputs(
  current: BpInTargetEnvelope | null,
  priorWeek: BpInTargetEnvelope | null,
): HealthScoreBpInputs {
  if (!current) {
    return {
      bpInTargetPct: null,
      bpInTargetPctPriorWeek: null,
      bpGradedScore: null,
      bpGradedScorePriorWeek: null,
    };
  }
  // v1.17 W1b — a thin 90-day window (below the confidence floor) is not a
  // trustworthy pillar input. Fall through to the all-time rate when the
  // 90-day window is itself sparse so a deep-history account survives a quiet
  // quarter, but never grade off a sub-floor 90-day sample.
  const last90Sufficient =
    current.last90Days !== null && isWindowSufficient(current.last90Days.pairs);
  const bpInTargetPct = last90Sufficient
    ? (current.last90Days?.pct ?? null)
    : (current.allTime?.pct ?? null);
  const priorWeek90Sufficient =
    priorWeek?.last90Days != null &&
    isWindowSufficient(priorWeek.last90Days.pairs);
  const bpInTargetPctPriorWeek = priorWeek90Sufficient
    ? (priorWeek?.last90Days?.pct ?? null)
    : (priorWeek?.allTime?.pct ?? null);
  // The graded clinical score is the pillar VALUE; suppress it together with
  // the rate when the 90-day window is thin AND no all-time rate rescues the
  // pillar, so the pillar disappears cleanly instead of grading a thin sample.
  // The prior-week graded score keys off the PRIOR-WEEK window's own presence
  // (not the current one) so the week-over-week delta never pairs a confident
  // current value against a thin-sample prior value.
  const pillarPresent = bpInTargetPct !== null;
  const priorPillarPresent = bpInTargetPctPriorWeek !== null;
  return {
    bpInTargetPct,
    bpInTargetPctPriorWeek,
    bpGradedScore: pillarPresent ? current.gradedScore : null,
    bpGradedScorePriorWeek: priorPillarPresent
      ? (priorWeek?.gradedScore ?? null)
      : null,
  };
}

/**
 * The weight-pillar slice of `HealthScoreFastPathInput`. Both Health-Score
 * callers spread this into their `computeUserHealthScoreFastPath` call so the
 * pillar is graded against the identical yardstick regardless of surface.
 */
export interface HealthScoreWeightTargetInputs {
  weightTarget: { min: number; max: number } | null;
  weightTargetSource: WeightTargetSource;
}

/**
 * Resolve the weight yardstick for the Health Score.
 *
 * The score grades weight against the user's OWN target or against nothing.
 * `getEffectiveRange` layers an evidence-based default under the override, and
 * that default is exactly what must NOT reach the score: it is a reference
 * band the person never chose and no score surface ever named. So the green
 * band is handed over only when `isOverride` is true; every other case resolves
 * to `null`, which routes the pillar through the honest trend-only path.
 *
 * Pure. `overrides` is the parsed `User.thresholdsJson` value (may be null).
 */
export function buildHealthScoreWeightTarget(
  profile: UserProfileForRange,
  overrides: ThresholdOverridesJson | null,
): HealthScoreWeightTargetInputs {
  const effective = getEffectiveRange("WEIGHT", profile, overrides);
  if (!effective.isOverride || !effective.range) {
    return { weightTarget: null, weightTargetSource: "none" };
  }
  return {
    weightTarget: {
      min: effective.range.greenMin,
      max: effective.range.greenMax,
    },
    weightTargetSource: "user",
  };
}
