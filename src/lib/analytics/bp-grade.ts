/**
 * v1.15.12 A1 — graded blood-pressure pillar score.
 *
 * The Personal Health Score's BP pillar previously equalled
 * `bpInTargetRate`: the share of paired readings where BOTH systolic and
 * diastolic sat at-or-below the age-band ceiling, scored binary per
 * reading over the all-time window. That metric is honest as a "% of
 * readings in range" stat, but it is the wrong thing to use AS the
 * pillar score: a user who averages 134/87 (borderline stage-1, every
 * reading slightly over the diastolic ceiling) collapses to ~10-16/100
 * because nearly every reading fails the binary check — even though
 * clinically they are "a bit high", not catastrophic. Improvement also
 * never shows, because the rate is all-time and a binary cliff.
 *
 * This module replaces the binary rate AS THE SCORE with a smooth
 * clinical-proximity grade. A representative BP (recency-weighted toward
 * the last weeks) is mapped to a 0-100 score per axis, and the pillar
 * takes the WORSE of the two sub-scores — so an elevated diastolic
 * counts against the score (it should) without binary-zeroing it.
 *
 * The curve is anchored on the SAME age-band ceiling the rest of the app
 * uses (`BpTargets.sysHigh` / `diaHigh` from `bp-targets.ts`). No new
 * thresholds are invented; the score bands are derived as offsets from
 * the configured ceiling:
 *
 *   offset from ceiling   →  axis score
 *   ≤ −12 (well below)        100  (optimal — comfortably in band)
 *      0  (at the ceiling)     85  (at goal — "well controlled")
 *     +5                       65
 *    +10                       52
 *    +20                       40
 *    +40                       18
 *    ≥ +60                      5  (far above — uncontrolled)
 *
 * Piecewise-linear between anchors — no hard cliffs, so a one-mmHg
 * change moves the score by a small, continuous amount. The diastolic
 * and systolic axes share the same offset→score table, so each axis is
 * judged against its own ceiling.
 *
 * Hypotension is penalised on a SEPARATE under-floor curve that is
 * CONTINUOUS with the optimal plateau at the boundary: at exactly the
 * clinical floor (`sys = 90`, `dia = 50`, mirroring `isBpReadingInTarget`)
 * the score is 100, and it descends smoothly as the value drops further
 * below the floor. The earlier implementation fed `floor − value` through
 * the over-target table, which made 1 mmHg under the floor jump to ~81 —
 * a 19-point cliff against the 100 the plateau holds AT the floor. The
 * dedicated anchors below (floor→100, floor−10→70, floor−20→45,
 * floor−30→20) mirror the over-target steepness without the cliff, so the
 * curve is continuous on BOTH sides of every boundary.
 *
 * Pure & deterministic — fully unit-tested in `__tests__/bp-grade.test.ts`.
 */
import type { BpTargets } from "./bp-targets";
import { SYS_HYPOTENSION_FLOOR, DIA_HYPOTENSION_FLOOR } from "./bp-in-target";

/**
 * Offset-from-ceiling → axis-score anchors. Offsets are in mmHg; the
 * first anchor is the "optimal" plateau (comfortably below the ceiling),
 * the last is the "uncontrolled" floor. Interpolated piecewise-linearly.
 */
const AXIS_ANCHORS: ReadonlyArray<readonly [offset: number, score: number]> = [
  [-12, 100],
  [0, 85],
  [5, 65],
  [10, 52],
  [20, 40],
  [40, 18],
  [60, 5],
] as const;

/**
 * Below-floor hypotension anchors. `below` is mmHg the value sits UNDER
 * the clinical floor; the score starts at 100 AT the floor (`below = 0`)
 * so the curve is continuous with the optimal plateau the over-target
 * branch holds at the floor, then descends to mirror the over-target
 * steepness. Interpolated piecewise-linearly; clamps below the last
 * anchor.
 */
const HYPO_ANCHORS: ReadonlyArray<readonly [below: number, score: number]> = [
  [0, 100],
  [10, 70],
  [20, 45],
  [30, 20],
  [40, 5],
] as const;

/**
 * Generic piecewise-linear interpolation over a monotonic-x anchor table.
 * Clamps to the first / last anchor outside the table range.
 */
function interpolateAnchors(
  anchors: ReadonlyArray<readonly [number, number]>,
  x: number,
): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x1, y1] = anchors[i];
    const [x2, y2] = anchors[i + 1];
    if (x >= x1 && x <= x2) {
      const fraction = (x - x1) / (x2 - x1);
      return y1 + fraction * (y2 - y1);
    }
  }
  return last[1];
}

/**
 * Piecewise-linear interpolation of an over-/under-target `offset`
 * (mmHg relative to the axis ceiling) onto the 0-100 axis score.
 * Clamps to the first / last anchor outside the table range.
 */
function interpolateAxisScore(offset: number): number {
  return interpolateAnchors(AXIS_ANCHORS, offset);
}

/**
 * Score one BP axis against its ceiling.
 *
 * - Above the floor: offset = `value - ceiling`. Negative offsets sit in
 *   the optimal plateau, positive ones climb the over-target curve.
 * - Below the hypotension floor: the distance below the floor is fed
 *   through the dedicated `HYPO_ANCHORS` curve, which starts at 100 AT
 *   the floor (`below = 0`) so the score is continuous with the plateau
 *   the over-target branch holds at the floor, then descends smoothly —
 *   no boundary cliff.
 */
function gradeAxis(value: number, ceiling: number, floor: number): number {
  if (value < floor) {
    return interpolateAnchors(HYPO_ANCHORS, floor - value);
  }
  return interpolateAxisScore(value - ceiling);
}

/**
 * Map a representative blood-pressure reading to a smooth 0-100 score.
 *
 * Takes the WORSE of the systolic and diastolic axis sub-scores so a
 * high diastolic counts against the score (it should) without
 * binary-zeroing the result the way the all-time in-target rate did.
 *
 * @returns integer 0-100.
 */
export function gradeBpScore(input: {
  sys: number;
  dia: number;
  target: BpTargets;
}): number {
  const sysScore = gradeAxis(
    input.sys,
    input.target.sysHigh,
    SYS_HYPOTENSION_FLOOR,
  );
  const diaScore = gradeAxis(
    input.dia,
    input.target.diaHigh,
    DIA_HYPOTENSION_FLOOR,
  );
  return Math.round(Math.max(0, Math.min(100, Math.min(sysScore, diaScore))));
}

/**
 * One timestamped BP pair for the recency-weighted representative.
 */
export interface BpPairPoint {
  /** Wall-clock of the reading (ms epoch ordering only — no tz math). */
  at: Date;
  sys: number;
  dia: number;
  /**
   * v1.15.12 — how many underlying readings this point stands for.
   * Defaults to 1 (one per-event pair). The rollup path collapses a day
   * into a single per-day-MEAN pair and passes `perDayPairCount` here so
   * a 4-reading day's mean counts 4× in the recency-weighted grade,
   * matching the live per-event behaviour. Without it a high-variance
   * day weighed 1:1 on rollup but N:1 on live, diverging the BP pillar by
   * up to ~20 points for the same data. The recency weight MULTIPLIES
   * this count.
   */
  count?: number;
}

/**
 * Collapse a series of paired BP readings into a single recency-weighted
 * representative `{ sys, dia }`, then grade it.
 *
 * Recent readings should dominate so that genuine improvement surfaces in
 * the score rather than being diluted by years of older readings. Each
 * pair is weighted by an exponential decay on its age relative to `now`,
 * with a half-life of `HALF_LIFE_DAYS` (45 d): a reading 45 days old
 * counts half as much as today's, 90 days old a quarter, etc. The
 * weighted mean of sys and dia is the representative reading.
 *
 * Returns `null` when the series is empty (caller leaves the pillar
 * absent — the redistribution helper then drops the BP weight cleanly).
 */
const HALF_LIFE_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

export function representativeBpFromSeries(input: {
  pairs: ReadonlyArray<BpPairPoint>;
  now: Date;
}): { sys: number; dia: number } | null {
  const { pairs, now } = input;
  if (pairs.length === 0) return null;

  const nowMs = now.getTime();
  let weightSum = 0;
  let sysWeighted = 0;
  let diaWeighted = 0;
  for (const p of pairs) {
    const ageDays = Math.max(0, (nowMs - p.at.getTime()) / DAY_MS);
    // The recency decay multiplies the per-point reading count so a
    // per-day-mean pair (rollup path) carries the same weight as the N
    // per-event pairs it stands for (live path).
    const count = p.count ?? 1;
    const weight = Math.pow(0.5, ageDays / HALF_LIFE_DAYS) * count;
    weightSum += weight;
    sysWeighted += weight * p.sys;
    diaWeighted += weight * p.dia;
  }
  if (weightSum === 0) return null;
  return {
    sys: sysWeighted / weightSum,
    dia: diaWeighted / weightSum,
  };
}

export function gradeBpScoreFromSeries(input: {
  pairs: ReadonlyArray<BpPairPoint>;
  target: BpTargets;
  now: Date;
}): number | null {
  const representative = representativeBpFromSeries(input);
  return representative
    ? gradeBpScore({ ...representative, target: input.target })
    : null;
}
