/**
 * One row per day, one column per thing the day was made of.
 *
 * The target is the day's own pleasantness (A1) and everything else is an
 * input: the other four level-A dimensions, the numbers and the closed
 * vocabularies of the day's context, and the figures the sleep, activity and
 * recovery modules already hold for that day. A1 is the only target on
 * purpose — five targets would be five ways to be wrong and five bands to
 * explain.
 *
 * Four rules this file is built on, each of which has a way of being got
 * wrong that looks fine on screen:
 *
 * 1. **Nothing is imputed. Ever.** A day with a missing input is not a day
 *    with an average input. The stated rule is complete cases: a day enters
 *    the fit only if it carries the target and every SELECTED feature, and a
 *    feature only becomes a candidate if it was recorded on at least
 *    {@link MIN_FEATURE_COVERAGE} of the days that carry a target. The
 *    coverage floor is what keeps the complete-case rule from quietly
 *    emptying the matrix: without it, one field somebody filled in twice
 *    would exclude every other day they ever logged.
 * 2. **Standardised per user, not min-max.** A person whose stress never
 *    exceeds six must not have six read as "maximum stress". The mean and the
 *    spread come from their own fit window, so every feature is expressed in
 *    that person's own units — which is also what makes the stored
 *    contributions comparable to each other.
 * 3. **Screened before it is fitted, with the multiple-comparison correction
 *    the rest of the product already runs.** A sweep over sixty context
 *    features at raw p < 0.05 finds three things that are not there. Pearson
 *    with the shared `MIN_PAIRED_N` floor, Benjamini-Hochberg at the shared
 *    `FDR_Q`, and the shared effect-size floor on the shrunk estimate — all
 *    imported, none re-tuned here.
 * 4. **Orientation comes from the table that owns it.** A2 is inverse and is
 *    flipped through `MOOD_DIMENSIONS[i].inverse`, never inline, so the chart
 *    and the model read one source. Context ratings are NOT flipped: no table
 *    states their orientation, and inventing one here would be exactly the
 *    second opinion the dimension table exists to prevent. It costs nothing
 *    mathematically — a flip only changes the sign of a coefficient, and the
 *    stored contribution is signed anyway.
 */
import {
  EFFECT_SIZE_FLOOR,
  FDR_Q,
  benjaminiHochberg,
  shrinkEstimate,
} from "@/lib/insights/correlation-discovery";
import {
  MAX_P_VALUE,
  MIN_PAIRED_N,
  pearson,
} from "@/lib/insights/correlations";
import {
  CONTACT_CIRCLE_KEYS,
  CONTACT_EXTENT_KEYS,
  CONTACT_FORM_KEYS,
  EVENT_TYPE_KEYS,
  LEISURE_CATEGORY_KEYS,
  WORK_STATUS_KEYS,
} from "@/lib/mood/context-vocabulary";
import { MOOD_DIMENSIONS } from "@/lib/mood/dimensions";
import type { MoodDimensionKey } from "@/lib/mood/dimensions";

import {
  contextNumericFeatureKey,
  contextValueFeatureKey,
  dimensionFeatureKey,
  linkedFeatureKey,
  LINKED_FEATURE_METRICS,
} from "./feature-keys";
import { occurrencesSuffice } from "./thresholds";

/**
 * Most features the fit may carry.
 *
 * Twelve over thirty days is already generous — a ridge penalty is what makes
 * that survivable at all — and the cap is what stops a well-logged account
 * from being fitted with sixty columns and a hundred rows.
 */
export const MAX_MODEL_FEATURES = 12;

/**
 * Share of target-carrying days a feature must be recorded on to be a
 * candidate at all.
 *
 * The other half of the complete-case rule. A field somebody filled in for a
 * fortnight and then stopped is not a column of the matrix; it is a fortnight,
 * and admitting it would silently discard every day outside that fortnight.
 */
export const MIN_FEATURE_COVERAGE = 0.6;

/** The day's context as the model reads it. The note never comes here. */
export interface PrognosisContextInput {
  workStatus: string | null;
  workMinutes: number | null;
  overtimeMinutes: number | null;
  workLoad: number | null;
  workSatisfaction: number | null;
  contactCircles: string[];
  contactForm: string | null;
  contactExtent: string | null;
  contactQuality: number | null;
  contactSupport: number | null;
  leisureCategories: string[];
  leisureMinutes: number | null;
  leisureJoy: number | null;
  leisureRecovery: number | null;
  eventType: string | null;
  eventValence: number | null;
}

/** One day, as everything upstream of the fit has resolved it. */
export interface PrognosisDayInput {
  /** Local day key, `YYYY-MM-DD`. */
  day: string;
  /** The target: the day's own pleasantness, 0-10. `null` days are not fitted. */
  a1: number | null;
  /** The other four self-ratings, literal as the person set them. */
  dimensions: Partial<Record<MoodDimensionKey, number | null>>;
  /** The day's stored context, or `null` when no section was opened. */
  context: PrognosisContextInput | null;
  /** What the owning modules hold for the day. `null` is absence. */
  linked: {
    sleepAsleep: number | null;
    steps: number | null;
    activeEnergy: number | null;
    restingHeartRate: number | null;
    heartRateVariability: number | null;
  };
}

/** The numeric context fields, in capture order. */
const CONTEXT_NUMERIC_FIELDS = [
  "workMinutes",
  "overtimeMinutes",
  "workLoad",
  "workSatisfaction",
  "contactQuality",
  "contactSupport",
  "leisureMinutes",
  "leisureJoy",
  "leisureRecovery",
  "eventValence",
] as const satisfies readonly (keyof PrognosisContextInput)[];

/** The single-valued vocabularies, each expanded to one column per value. */
const CONTEXT_SINGLE_VOCABULARIES = [
  { field: "workStatus", keys: WORK_STATUS_KEYS },
  { field: "contactForm", keys: CONTACT_FORM_KEYS },
  { field: "contactExtent", keys: CONTACT_EXTENT_KEYS },
  { field: "eventType", keys: EVENT_TYPE_KEYS },
] as const;

/** The multi-select vocabularies, same expansion. */
const CONTEXT_MULTI_VOCABULARIES = [
  { field: "contactCircles", keys: CONTACT_CIRCLE_KEYS },
  { field: "leisureCategories", keys: LEISURE_CATEGORY_KEYS },
] as const;

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Every feature this day carries a value for.
 *
 * A feature the day says nothing about is ABSENT from the map — it is not
 * zero. The difference is the whole of rule 1: a day with no context row has
 * no work-status column at all, while a day whose work status is `off` has a
 * zero in every other work-status column and a one in that one.
 */
export function extractDayFeatures(
  day: PrognosisDayInput,
): Map<string, number> {
  const out = new Map<string, number>();

  for (const dimension of MOOD_DIMENSIONS) {
    // A1 is the target, not an input. Fitting a value on itself would produce
    // a perfect model of nothing.
    if (dimension.key === "a1") continue;
    const raw = day.dimensions[dimension.key];
    if (!isNumber(raw)) continue;
    // The orientation flip goes through the table that declares it, so a
    // dimension that becomes inverse later moves the chart and the model
    // together.
    out.set(
      dimensionFeatureKey(dimension.key),
      dimension.inverse ? dimension.max - raw : raw,
    );
  }

  const context = day.context;
  if (context) {
    for (const field of CONTEXT_NUMERIC_FIELDS) {
      const raw = context[field];
      if (isNumber(raw)) out.set(contextNumericFeatureKey(field), raw);
    }
    for (const { field, keys } of CONTEXT_SINGLE_VOCABULARIES) {
      const value = context[field];
      // A field nobody answered contributes no columns. Zeroing them would
      // tell the fit "not overtime" on a day nobody said anything about work.
      if (typeof value !== "string" || value.length === 0) continue;
      for (const key of keys) {
        out.set(contextValueFeatureKey(field, key), value === key ? 1 : 0);
      }
    }
    for (const { field, keys } of CONTEXT_MULTI_VOCABULARIES) {
      const values = context[field];
      if (!Array.isArray(values) || values.length === 0) continue;
      const chosen = new Set(values);
      for (const key of keys) {
        out.set(contextValueFeatureKey(field, key), chosen.has(key) ? 1 : 0);
      }
    }
  }

  for (const metric of LINKED_FEATURE_METRICS) {
    const raw = day.linked[metric];
    if (isNumber(raw)) out.set(linkedFeatureKey(metric), raw);
  }

  return out;
}

/** What the screening decided about one candidate, kept for the tests. */
export interface ScreenedFeature {
  key: string;
  /** Days carrying both the feature and the target. */
  pairs: number;
  r: number;
  /** The shrunk estimate the effect floor is applied to. */
  shrunk: number;
  pValue: number;
  qValue: number;
  selected: boolean;
  /** Why it was refused, when it was. */
  reason?:
    | "coverage"
    | "too-few-pairs"
    | "no-variance"
    | "p-value"
    | "fdr"
    | "effect-size"
    | "occurrences"
    | "cap";
}

/**
 * Which candidates earn a column, and why the others did not.
 *
 * Order of refusal matters and is the order below: coverage, then pairs, then
 * the raw p, then the family-wide FDR, then the effect floor, then the cap.
 * A feature that fails an earlier gate is not tested against a later one, so
 * the family the FDR corrects over is the set that was actually tested.
 */
export function screenFeatures(
  days: readonly PrognosisDayInput[],
): ScreenedFeature[] {
  const targetDays = days.filter((d) => isNumber(d.a1));
  const perDay = new Map<string, Map<string, number>>();
  for (const day of targetDays) perDay.set(day.day, extractDayFeatures(day));

  const candidates = new Set<string>();
  for (const features of perDay.values()) {
    for (const key of features.keys()) candidates.add(key);
  }

  const coverageFloor = targetDays.length * MIN_FEATURE_COVERAGE;
  const refused: ScreenedFeature[] = [];
  const tested: Array<{
    key: string;
    pairs: number;
    r: number;
    shrunk: number;
    pValue: number;
  }> = [];

  for (const key of [...candidates].sort()) {
    const xs: number[] = [];
    const ys: number[] = [];
    let occurrences = 0;
    for (const day of targetDays) {
      const value = perDay.get(day.day)?.get(key);
      if (value === undefined) continue;
      xs.push(value);
      ys.push(day.a1 as number);
      if (value !== 0) occurrences += 1;
    }

    if (xs.length < coverageFloor) {
      refused.push(zero(key, xs.length, "coverage"));
      continue;
    }
    // A one-hot column seen four times is not evidence, however well it
    // correlates. This is the ladder's occurrence floor, not a second one.
    if (!occurrencesSuffice(occurrences)) {
      refused.push(zero(key, xs.length, "occurrences"));
      continue;
    }

    const result = pearson({ xs, ys, minPairs: MIN_PAIRED_N });
    if (result.status === "insufficient") {
      refused.push(
        zero(
          key,
          result.n,
          result.reason === "no_variance" ? "no-variance" : "too-few-pairs",
        ),
      );
      continue;
    }
    if (result.pValue >= MAX_P_VALUE) {
      refused.push({
        key,
        pairs: result.n,
        r: result.r,
        shrunk: shrinkEstimate(result.r, result.n),
        pValue: result.pValue,
        qValue: 1,
        selected: false,
        reason: "p-value",
      });
      continue;
    }
    tested.push({
      key,
      pairs: result.n,
      r: result.r,
      shrunk: shrinkEstimate(result.r, result.n),
      pValue: result.pValue,
    });
  }

  const qValues = benjaminiHochberg(tested.map((t) => t.pValue));
  const survivors: ScreenedFeature[] = [];
  tested.forEach((t, index) => {
    const qValue = qValues[index] ?? 1;
    if (qValue > FDR_Q) {
      survivors.push({ ...t, qValue, selected: false, reason: "fdr" });
      return;
    }
    if (Math.abs(t.shrunk) < EFFECT_SIZE_FLOOR) {
      survivors.push({ ...t, qValue, selected: false, reason: "effect-size" });
      return;
    }
    survivors.push({ ...t, qValue, selected: true });
  });

  // The cap keeps the strongest, and a stable tie-break by key keeps two runs
  // over the same data returning the same columns.
  const admitted = survivors
    .filter((s) => s.selected)
    .sort(
      (a, b) =>
        Math.abs(b.shrunk) - Math.abs(a.shrunk) || a.key.localeCompare(b.key),
    );
  for (const feature of admitted.slice(MAX_MODEL_FEATURES)) {
    feature.selected = false;
    feature.reason = "cap";
  }

  return [...survivors, ...refused].sort((a, b) => a.key.localeCompare(b.key));
}

function zero(
  key: string,
  pairs: number,
  reason: ScreenedFeature["reason"],
): ScreenedFeature {
  return {
    key,
    pairs,
    r: 0,
    shrunk: 0,
    pValue: 1,
    qValue: 1,
    selected: false,
    reason,
  };
}

/** Per-feature centre and spread, over this account's own fit window. */
export interface FeatureStandardisation {
  key: string;
  mean: number;
  sd: number;
}

export interface FeatureMatrix {
  /** The selected feature keys, in column order. */
  features: string[];
  /** Standardised rows, one per complete day, oldest first. */
  rows: number[][];
  /** The target for each row, unstandardised (0-10). */
  targets: number[];
  /** The day each row is, so the validation can stay time-ordered. */
  days: string[];
  /** What each column was standardised by, needed to score a new day. */
  standardisation: FeatureStandardisation[];
}

/**
 * Build the matrix: screen, then keep the complete days, then standardise.
 *
 * Returns `null` when nothing survives the screening or when no day carries
 * every surviving feature. That is a refusal, not an empty matrix — the caller
 * writes no forecast rather than one built on nothing.
 */
export function buildFeatureMatrix(
  days: readonly PrognosisDayInput[],
): FeatureMatrix | null {
  const screened = screenFeatures(days);
  const selected = screened.filter((s) => s.selected).map((s) => s.key);
  if (selected.length === 0) return null;

  const ordered = [...days]
    .filter((d) => isNumber(d.a1))
    .sort((a, b) => a.day.localeCompare(b.day));

  const rawRows: number[][] = [];
  const targets: number[] = [];
  const dayKeys: string[] = [];
  for (const day of ordered) {
    const features = extractDayFeatures(day);
    const row: number[] = [];
    let complete = true;
    for (const key of selected) {
      const value = features.get(key);
      if (value === undefined) {
        complete = false;
        break;
      }
      row.push(value);
    }
    // Complete cases only. A day missing one selected feature is a day the fit
    // does not see; nothing is filled in for it.
    if (!complete) continue;
    rawRows.push(row);
    targets.push(day.a1 as number);
    dayKeys.push(day.day);
  }

  if (rawRows.length === 0) return null;

  const standardisation = selected.map((key, column) => {
    const values = rawRows.map((row) => row[column]);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) /
      values.length;
    return { key, mean, sd: Math.sqrt(variance) };
  });

  // A column with no spread inside the complete-case set carries no
  // information and would divide by zero. It goes, and if that empties the
  // set the whole fit is refused.
  const keep = standardisation
    .map((s, index) => ({ ...s, index }))
    .filter((s) => s.sd > 0);
  if (keep.length === 0) return null;

  return {
    features: keep.map((k) => k.key),
    rows: rawRows.map((row) => keep.map((k) => (row[k.index] - k.mean) / k.sd)),
    targets,
    days: dayKeys,
    standardisation: keep.map(({ key, mean, sd }) => ({ key, mean, sd })),
  };
}

/**
 * Standardise one day's raw features against a stored fit, for scoring.
 *
 * `null` when the day does not carry every feature the fit uses — the same
 * complete-case rule the matrix applies, asked of a single day. A day that
 * cannot be scored gets no forecast, which is the honest answer.
 */
export function standardiseDay(
  day: PrognosisDayInput,
  standardisation: readonly FeatureStandardisation[],
): number[] | null {
  const features = extractDayFeatures(day);
  const row: number[] = [];
  for (const { key, mean, sd } of standardisation) {
    const value = features.get(key);
    if (value === undefined || sd <= 0) return null;
    row.push((value - mean) / sd);
  }
  return row;
}
