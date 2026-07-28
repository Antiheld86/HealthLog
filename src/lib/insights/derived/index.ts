/**
 * v1.10.0 — public barrel for the derived-metrics layer.
 *
 * The one module every consumer imports from. Append-only per wave —
 * Wave 1 exports the foundation (`Derived<T>` + coverage builders +
 * registry + norms + the flagship baseline engine + the route
 * dispatcher); W2/W3 append their per-metric engines (`fitness-age`,
 * `vascular-age`, `sleep-score`, `readiness`) here.
 *
 * Re-exports the client-safe types/coverage builders and the
 * server-only compute engines from one place; consumers import only what
 * they need. (A `"use client"` component must value-import only from
 * `./types` + `./coverage` + `./registry` — those are server-import-free.
 * The route + server consumers may import the engines below.)
 */

// ── client-safe contract (types + pure builders + metadata) ──────────
export type {
  Derived,
  DerivedOk,
  DerivedInsufficient,
  DerivedCoverage,
  DerivedConfidence,
  DerivedConfidenceBand,
  DerivedProvenance,
  DerivedProvenanceSource,
} from "./types";
export { isDerivedOk } from "./types";

export {
  deriveCoverage,
  buildOk,
  buildInsufficient,
  scoreToBand,
  nowProvenanceTimestamp,
} from "./coverage";
export type { DeriveCoverageArgs } from "./coverage";

export {
  DERIVED_METRIC_IDS,
  VITALS_BASELINE_TYPES,
  TRAJECTORY_TYPES,
  SAME_TIME_BASELINE_TYPES,
  SAME_TIME_BASELINE_WINDOW_DAYS,
  SAME_TIME_BASELINE_MIN_HISTORY_DAYS,
  isDerivedMetricId,
  getDerivedMetricMeta,
  isVitalsBaselineType,
  isTrajectoryType,
  isSameTimeBaselineType,
} from "./registry";
export type {
  DerivedMetricId,
  DerivedMetricMeta,
  DerivedArchetype,
} from "./registry";

export {
  lookupNormalRange,
  hasSharpenedNorm,
  predictSixMinuteWalkDistance,
} from "./norms";
export type { NormRange, NormSex } from "./norms";

// ── server-only compute engines (do NOT value-import from a client component) ──
export {
  computeVitalsBaseline,
  loadBaselineProfile,
  buildBaselineBand,
  median,
  medianAbsoluteDeviation,
} from "./baseline";
export type {
  VitalsBaselineValue,
  VitalsBaselineOpts,
  BaselineProfile,
} from "./baseline";

export { computeDerivedMetric } from "./dispatch";
export type { DerivedComputeArgs } from "./dispatch";

// ── W2b vitals tier: passthrough re-frames + derived bands ───────────
export {
  computeFitnessAge,
  placeVo2Band,
  fitnessAgeDeltaYears,
} from "./fitness-age";
export type { FitnessAgeValue, FitnessBand } from "./fitness-age";

export {
  computeSixMinuteWalkBand,
  placeSixMinuteWalkBand,
} from "./six-minute-walk";
export type { SixMinuteWalkValue, SixMinuteWalkBand } from "./six-minute-walk";

export { computeVascularAgeDelta, placeVascularBand } from "./vascular-age";
export type { VascularAgeDeltaValue, VascularBand } from "./vascular-age";

export { computeHrvBalance, placeHrvBalance } from "./hrv-balance";
export type { HrvBalanceValue, HrvBalanceBand } from "./hrv-balance";

export { computeBmi, classifyBmi } from "./bmi";
export type { BmiValue, BmiBand, BmiCategory } from "./bmi";
// ── W3 composites (server-only compute engines) ──────────────────────
export {
  computeSleepScore,
  blendSleepSubScores,
  reconstructNights,
  sleepNeedMinutes,
  scoreSufficiency,
  scoreEfficiency,
  scoreComposition,
  scoreConsistency,
  scoreTiming,
  SLEEP_SUBSCORE_WEIGHTS,
} from "./sleep-score";
export type {
  SleepScoreValue,
  SleepScoreOpts,
  SleepSubScore,
  SleepSubScoreKey,
  NightSummary,
} from "./sleep-score";

export {
  computeReadiness,
  blendReadinessComponents,
  scoreDeviation,
  READINESS_WEIGHTS,
  READINESS_MIN_COMPONENTS,
} from "./readiness";
export type {
  ReadinessValue,
  ReadinessOpts,
  ReadinessComponent,
  ReadinessComponentKey,
} from "./readiness";

export {
  computeCoincidentDeviation,
  classifyDeviation,
  COINCIDENT_FIRE_THRESHOLD,
  COINCIDENT_MIN_BANDS,
} from "./coincident-deviation";
export type {
  CoincidentDeviationValue,
  CoincidentDeviationOpts,
  VitalDeviation,
} from "./coincident-deviation";

// ── persisted nightly wellness scores (passthrough read) ─────────────
export {
  computeWellnessScore,
  bandWellnessScore,
  WELLNESS_SCORE_TYPES,
} from "./wellness-scores";
export type {
  WellnessScoreValue,
  WellnessScoreBand,
  WellnessScoreType,
  WellnessScoreOpts,
} from "./wellness-scores";

// ── v1.11.0 (Epic B, Pillar 3) forecasting engine (server-only) ──────
export {
  computeTrajectory,
  fitOls,
  predictionIntervalHalfWidth,
  TRAJECTORY_MIN_R2,
  TRAJECTORY_MIN_HISTORY_DAYS,
} from "./trajectory";
export type {
  TrajectoryValue,
  TrajectoryPoint,
  TrajectoryOpts,
  OlsFit,
} from "./trajectory";

// ── v1.34.0 same-time baseline for cumulative metrics (server-only) ──
export { computeSameTimeBaseline } from "./same-time-baseline";
export type {
  SameTimeBaselineValue,
  SameTimeBaselineOpts,
  SameTimeBand,
} from "./same-time-baseline";
