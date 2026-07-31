import type { BpTargets } from "@/lib/analytics/bp-targets";
import type { BpGrade, BpScoreBasis } from "@/lib/analytics/bp-grade";
import type {
  Derived,
  DerivedProvenanceSource,
} from "@/lib/insights/derived/types";
import type { ProfileSex } from "@/lib/profile/sex";

export const SCORE_VERSION = 2 as const;

export const SCORE_PILLAR_IDS = [
  "BLOOD_PRESSURE",
  "GLYCAEMIA",
  "ACTIVITY",
  "SLEEP",
  "ADIPOSITY",
  "WELLBEING",
  "FITNESS",
  "LIPIDS",
] as const;

export type ScorePillarId = (typeof SCORE_PILLAR_IDS)[number];

/**
 * Sanitise a list of pillar ids: registry order, no duplicates, and
 * anything outside the catalogue dropped. Everything that narrows the
 * score's composition goes through here, so a stored blob, a caller's
 * argument and the scorer itself cannot disagree about what a valid
 * pillar set looks like.
 */
export function orderedUniquePillars(ids: readonly unknown[]): ScorePillarId[] {
  const present = new Set(ids);
  return SCORE_PILLAR_IDS.filter((id) => present.has(id));
}
export type ScoreBand = "green" | "yellow" | "red";
export type ScoreDomain =
  | "cardiometabolic"
  | "activity"
  | "sleep"
  | "adiposity"
  | "wellbeing"
  | "fitness";

/**
 * Which domain each pillar speaks to. The composite needs three
 * distinct domains, so this map is part of the breadth rule and not
 * decoration: three of the eight pillars share the cardiometabolic
 * domain, which is why a selection of five pillars can still fail.
 *
 * One map, read by the scorer when it builds a pillar result and by the
 * breadth rule when it judges a selection, so the two can never drift
 * into disagreeing about what counts as a distinct area.
 */
export const SCORE_PILLAR_DOMAINS: Record<ScorePillarId, ScoreDomain> = {
  BLOOD_PRESSURE: "cardiometabolic",
  GLYCAEMIA: "cardiometabolic",
  ACTIVITY: "activity",
  SLEEP: "sleep",
  ADIPOSITY: "adiposity",
  WELLBEING: "wellbeing",
  FITNESS: "fitness",
  LIPIDS: "cardiometabolic",
};

export type PillarReferenceKind =
  "clinical-threshold" | "population-percentile" | "guideline-band";

export interface PillarObserved {
  value: number;
  unit: string;
  /** Complete display value, including paired or panel values where needed. */
  label: string;
  asOf: string;
  /** Persisted source labels that contributed to the observation. */
  sources: string[];
}

export interface PillarReference {
  kind: PillarReferenceKind;
  low: number | null;
  high: number | null;
  /** Complete display band for paired or multi-marker references. */
  label: string;
  source: string;
}

export interface PillarValue {
  score: number;
  observed: PillarObserved;
  reference: PillarReference;
  /** Optional user-authored yardstick, displayed beside the scored reference. */
  personalReference?: PillarReference;
  /**
   * Which input set this score and by how much, resolved on the server so
   * no client ever re-derives it. Blood pressure only for now: it is the
   * one pillar that scores the WORSE of two axes, so the number alone
   * cannot say which one it came from. Optional by design — a pillar that
   * has nothing of the kind to say says nothing.
   */
  scoreBasis?: BpScoreBasis;
  /** Score points that a weekly move must clear before it is narrated. */
  noiseFloor: number;
  /** Slow markers contribute to level but never to the weekly delta. */
  deltaEligible: boolean;
  /** Input/scoring mode identity used to form like-for-like deltas. */
  deltaIdentity: string;
}

export interface ScorePillarResult {
  id: ScorePillarId;
  domain: ScoreDomain;
  result: Derived<PillarValue>;
}

export interface CompositeValue {
  score: number;
  band: ScoreBand;
  /** Non-null only when the worst pillar lowers the mean score's band. */
  bandSetter: ScorePillarId | null;
  /** Registry-ordered eligible pillar ids. Part of the number's identity. */
  composition: ScorePillarId[];
  /**
   * v1.35.0 — the resolved "this score is configured" flag: true when the
   * account's composition differs from the one its defaults would resolve
   * to today. Server-resolved so no client interprets a config blob, and
   * never a per-pillar detail. `resolveScoreConfigured` in `./config`
   * owns the definition and the reasons behind it.
   */
  configured: boolean;
  /** Equal-weighted floor across delta-eligible pillars. */
  noiseFloor: number;
  scoreVersion: typeof SCORE_VERSION;
}

export type ScoreDeltaReason =
  | "algorithm_changed"
  /**
   * The person changed their own recipe inside the comparison window.
   * Distinct from `algorithm_changed` (we changed the method for
   * everybody) and from `composition_changed` (the two windows ended up
   * with different pillar sets): here both windows are computed under
   * the NEW recipe in one request, so the sets agree and the arithmetic
   * looks comparable when it is not. Without this reason the settings
   * action reads as a health event.
   */
  | "config_changed"
  | "composition_changed"
  | "first_eligibility_window"
  | "below_noise_floor"
  | "no_previous_window"
  | "no_current_score";

export interface WeightGoalValue {
  currentKg: number;
  target: { min: number; max: number };
  distanceKg: number;
  /** Positive means the distance to the personal band narrowed. */
  deltaKg: number | null;
  asOf: string;
  source: string;
}

export interface RestModeAnnotation {
  active: true;
  since: string | null;
  episodeCount: number;
}

export interface HealthScoreReport {
  composite: Derived<CompositeValue>;
  pillars: ScorePillarResult[];
  delta: number | null;
  deltaReason: ScoreDeltaReason | null;
  scoreVersion: typeof SCORE_VERSION;
  weightGoal: Derived<WeightGoalValue>;
  algorithmNotice: { itemKey: string; dismissed: boolean } | null;
  restMode?: RestModeAnnotation | null;
}

export interface DomainReadState {
  source: DerivedProvenanceSource;
  readFailed: boolean;
}

export interface BloodPressurePillarInput extends DomainReadState {
  asOf: Date;
  pairCount: number;
  /**
   * The graded score together with the basis that produced it — one
   * value, from one grading run against one set of targets.
   */
  graded: BpGrade | null;
  representative: { sys: number; dia: number } | null;
  oldestAt: Date | null;
  latestAt: Date | null;
  target: BpTargets | null;
  personalTarget?: BpTargets | null;
  sources: string[];
}

export interface HbA1cReading {
  value: number;
  unit: string;
  at: Date;
  source: string;
}

export interface GlucoseReading {
  value: number;
  at: Date;
  source: string;
}

export interface GlycaemiaPillarInput extends DomainReadState {
  asOf: Date;
  hba1cReadFailed?: boolean;
  fastingReadFailed?: boolean;
  hba1c: HbA1cReading[];
  fastingGlucose: GlucoseReading[];
}

export interface ActivityDay {
  day: string;
  value: number;
}

export interface ActivityPillarInput extends DomainReadState {
  asOf: Date;
  timezone: string;
  ageYears: number | null;
  days: ActivityDay[];
  sources: string[];
}

export interface SleepPillarNight {
  night: string;
  asleepMinutes: number;
  midpoint: number | null;
}

export interface SleepPillarInput extends DomainReadState {
  asOf: Date;
  timezone: string;
  ageYears: number | null;
  nights: SleepPillarNight[];
  sources: string[];
}

export interface AdiposityReading {
  type: "WAIST_CIRCUMFERENCE" | "WAIST_TO_HEIGHT";
  value: number;
  unit: string;
  at: Date;
  source: string;
}

export interface AdiposityPillarInput extends DomainReadState {
  asOf: Date;
  heightCm: number | null;
  rows: AdiposityReading[];
}

export interface WellbeingAssessment {
  instrument: "PHQ9" | "GAD7" | "WHO5";
  totalScore: number;
  item9Flagged: boolean;
  at: Date;
}

export interface WellbeingPillarInput extends DomainReadState {
  asOf: Date;
  assessments: WellbeingAssessment[];
}

export interface FitnessReading {
  value: number;
  at: Date;
  source: string;
  /** True only when persisted provenance proves a measured CPET/test. */
  measured: boolean;
}

export interface FitnessPillarInput extends DomainReadState {
  asOf: Date;
  ageYears: number | null;
  sex: ProfileSex;
  rows: FitnessReading[];
}

export interface LipidReading {
  marker: string;
  value: number;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  panel: string | null;
  at: Date;
  source: string;
}

export interface LipidsPillarInput extends DomainReadState {
  asOf: Date;
  rows: LipidReading[];
}

export interface PillarInputs {
  BLOOD_PRESSURE: BloodPressurePillarInput;
  GLYCAEMIA: GlycaemiaPillarInput;
  ACTIVITY: ActivityPillarInput;
  SLEEP: SleepPillarInput;
  ADIPOSITY: AdiposityPillarInput;
  WELLBEING: WellbeingPillarInput;
  FITNESS: FitnessPillarInput;
  LIPIDS: LipidsPillarInput;
}
