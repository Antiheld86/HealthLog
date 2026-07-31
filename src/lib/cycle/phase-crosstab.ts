/**
 * v1.15 — CYCLE_PHASE × vital crosstab + discovery channel.
 *
 * The cycle phase becomes one more channel in the same FDR-guarded discovery
 * machinery the RATED mood factors were folded into in v1.14.0 — no new
 * statistics. Two complementary mechanisms (integration-audit §1):
 *
 *  A. PHASE-CONTRAST (categorical → Welch + BH-FDR). Per outcome metric,
 *     compare the LUTEAL day-group against the FOLLICULAR day-group — the two
 *     phases with the largest documented physiological contrast — through the
 *     identical `welchTTest` + `benjaminiHochberg` pipeline the mood-factor
 *     crosstab runs (`computeFactorMetricCrosstab` in
 *     `src/lib/insights/mood-aggregates.ts`). Same day floors, same q = 0.10,
 *     same confidence bands.
 *
 *  B. CONTINUOUS ordinal channel for the lagged-Pearson matrix. The phase maps
 *     to {MENSTRUAL:0, FOLLICULAR:1, OVULATORY:2, LUTEAL:3} and enters
 *     `discoverCorrelations` as a `NamedSeries{ key: "CYCLE_PHASE", role:
 *     "behaviour" }` exactly the way a `FACTOR:` channel does.
 *
 * Pure + DB-free: every function here takes already-fetched rows (the gated
 * `/api/cycle/insights` route does the reads + the gender gate). The phase-day
 * membership comes from `buildPhaseDayMap` in `engine-adapter.ts`, derived
 * identically to the calendar grid so the phase the stats use matches the
 * phase the UI shows.
 *
 * Privacy: this lives ONLY behind the cycle gate. `WRIST_TEMPERATURE` /
 * `SKIN_TEMPERATURE` are deliberately held OUT of the GENERAL correlation
 * matrix (`correlation-discovery.ts`) precisely so a cycle-phase relation can
 * never leak into a non-gender-gated surface; the cycle feature is the
 * deliberate decision that un-blocks them here, and nowhere else.
 */
import {
  metricDayMap,
  influenceConfidence,
  CROSSTAB_MIN_PRESENT_DAYS,
  CROSSTAB_MIN_ABSENT_DAYS,
  CROSSTAB_FDR_Q,
  CROSSTAB_MAX_ROWS,
  type CrossMetricMeasurement,
  type InfluenceConfidence,
} from "@/lib/insights/mood-aggregates";
import { welchTTest } from "@/lib/insights/correlations";
import {
  benjaminiHochberg as fdrAdjust,
  discoverCorrelations,
  type NamedSeries,
  type DailySeriesPoint,
  type CorrelationDiscoveryResult,
} from "@/lib/insights/correlation-discovery";
import { round } from "@/lib/insights/status-shared";
import type { MeasurementType } from "@/generated/prisma/enums";
import type { CyclePhase } from "@/lib/cycle/types";
import type { Locale } from "@/lib/i18n/config";

/** Stable channel key for the continuous CYCLE_PHASE discovery series. */
export const CYCLE_PHASE_CHANNEL_KEY = "CYCLE_PHASE";

/**
 * Ordinal encoding of the phase for the continuous lagged-Pearson channel —
 * the menstrual→luteal progression as a monotone 0..3 scale. The contrast
 * crosstab (mechanism A) uses the categorical label directly and never this
 * ordinal; the ordinal exists only for mechanism B.
 */
export const PHASE_ORDINAL: Record<CyclePhase, number> = {
  MENSTRUAL: 0,
  FOLLICULAR: 1,
  OVULATORY: 2,
  LUTEAL: 3,
};

/** Display-unit hint the client formatter branches on. */
export type PhaseCrosstabDisplay =
  "hours" | "steps" | "bpm" | "ms" | "kg" | "celsius" | "glucose" | "mood";

/**
 * Synthetic non-MeasurementType channel key for the MOOD outcome. Mood lives in
 * the separate `MoodEntry` model (1–5 score), not a Measurement row, so the
 * caller injects it into the crosstab `measurements` array tagged with this key
 * and `metricDayMap` groups it like any other type (its pass-through fallback
 * keeps every row — there is no source ladder for mood). It is deliberately NOT
 * a member of `PHASE_CROSSTAB_METRIC_TYPES`, so it never enters the Measurement
 * read query.
 */
export const MOOD_CHANNEL_KEY = "MOOD";

/**
 * The outcome metric grid the phase contrast walks. Mirrors
 * `FACTOR_CROSSTAB_METRICS` (RHR / HRV / sleep / steps / weight) and EXTENDS it
 * with the temperature channels (BBT + passive wrist/skin temp) that the
 * audit flags as both a phase-correlation outcome AND the symptothermal
 * ovulation input — surfaced here, never on the general matrix.
 */
export const PHASE_CROSSTAB_METRICS: Record<
  string,
  {
    type: MeasurementType | typeof MOOD_CHANNEL_KEY;
    display: PhaseCrosstabDisplay;
  }
> = {
  restingHeartRate: { type: "RESTING_HEART_RATE", display: "bpm" },
  heartRateVariability: { type: "HEART_RATE_VARIABILITY", display: "ms" },
  sleepDuration: { type: "SLEEP_DURATION", display: "hours" },
  steps: { type: "ACTIVITY_STEPS", display: "steps" },
  weight: { type: "WEIGHT", display: "kg" },
  basalBodyTemp: { type: "BODY_TEMPERATURE", display: "celsius" },
  wristTemperature: { type: "WRIST_TEMPERATURE", display: "celsius" },
  skinTemperature: { type: "SKIN_TEMPERATURE", display: "celsius" },
  // QA HIGH (features): the crosstab must cover MOOD + GLUCOSE as outcomes,
  // under the identical FDR / day-floor guards. Glucose is a MeasurementType;
  // mood is the synthetic MOOD_CHANNEL_KEY the route injects (see above).
  bloodGlucose: { type: "BLOOD_GLUCOSE", display: "glucose" },
  mood: { type: MOOD_CHANNEL_KEY, display: "mood" },
} as const;

export type PhaseCrosstabMetricKey = keyof typeof PHASE_CROSSTAB_METRICS;

/**
 * Distinct MeasurementType values the phase crosstab reads — single-sourced.
 * MOOD_CHANNEL_KEY is excluded: it is not a Measurement row (the route reads it
 * from MoodEntry and injects it), so it must never enter the Measurement query.
 */
export const PHASE_CROSSTAB_METRIC_TYPES: MeasurementType[] = Array.from(
  new Set(
    Object.values(PHASE_CROSSTAB_METRICS)
      .map((m) => m.type)
      .filter((t): t is MeasurementType => t !== MOOD_CHANNEL_KEY),
  ),
);

/** The two phases the categorical contrast compares (largest contrast). */
const CONTRAST_HIGH: CyclePhase = "LUTEAL";
const CONTRAST_LOW: CyclePhase = "FOLLICULAR";

export interface PhaseMetricCrosstabRow {
  /** Which metric channel this row compares against. */
  metricKey: PhaseCrosstabMetricKey;
  /** Display-unit hint for the client formatter. */
  display: PhaseCrosstabDisplay;
  /** Days in the luteal group with a paired metric value. */
  lutealDays: number;
  /** Days in the follicular group with a paired metric value. */
  follicularDays: number;
  /** Mean metric on luteal days (display unit). */
  lutealAvg: number;
  /** Mean metric on follicular days (display unit). */
  follicularAvg: number;
  /** lutealAvg − follicularAvg (display unit). Positive = higher in luteal. */
  delta: number;
  /** Welch two-sided p-value for the difference of means. */
  pValue: number;
  /** Benjamini-Hochberg adjusted q-value across the tested family. */
  qValue: number;
  /** Discrete confidence band (p + min per-group day count). */
  confidence: InfluenceConfidence;
}

/** Convert a raw metric value to its phase-crosstab display unit. */
function toDisplayUnit(value: number, display: PhaseCrosstabDisplay): number {
  return display === "hours" ? value / 60 : value;
}

interface PhaseCrosstabCandidate {
  row: Omit<PhaseMetricCrosstabRow, "qValue">;
}

/**
 * Compute the CYCLE_PHASE × metric crosstab. Pure over already-fetched rows.
 *
 * For every configured metric, group the per-day deduped metric values by
 * whether the day was LUTEAL or FOLLICULAR (the phase-day map). Each group's
 * samples feed `welchTTest`; rows that clear both day floors are tested,
 * FDR-corrected as ONE family, and the survivors (p < 0.05 AND q ≤
 * `CROSSTAB_FDR_Q`) surface ranked by q then |delta|.
 *
 * Honest: thin data never fabricates a row (the day floors + FDR gate are the
 * mood crosstab's, unchanged); a population-typical relation that does not
 * appear in the user's own data simply yields no row.
 */
export function computePhaseMetricCrosstab(args: {
  /** `YYYY-MM-DD → CyclePhase` for every dated day in the window. */
  phaseByDay: Map<string, CyclePhase>;
  measurements: CrossMetricMeasurement[];
  /** The user's source-priority blob (threaded into `metricDayMap`). */
  userPriorityJson?: unknown;
}): PhaseMetricCrosstabRow[] {
  const { phaseByDay, measurements } = args;
  const userPriorityJson = args.userPriorityJson ?? null;
  if (phaseByDay.size === 0) return [];

  const candidates: PhaseCrosstabCandidate[] = [];

  for (const [metricKey, cfg] of Object.entries(
    PHASE_CROSSTAB_METRICS,
  ) as Array<
    [
      PhaseCrosstabMetricKey,
      (typeof PHASE_CROSSTAB_METRICS)[PhaseCrosstabMetricKey],
    ]
  >) {
    const metricByDay = metricDayMap(measurements, cfg.type, userPriorityJson);
    if (metricByDay.size === 0) continue;

    const lutealVals: number[] = [];
    const follicularVals: number[] = [];
    for (const [dayKey, phase] of phaseByDay) {
      if (phase !== CONTRAST_HIGH && phase !== CONTRAST_LOW) continue;
      const metricValue = metricByDay.get(dayKey);
      if (metricValue == null || !Number.isFinite(metricValue)) continue;
      const display = toDisplayUnit(metricValue, cfg.display);
      if (phase === CONTRAST_HIGH) lutealVals.push(display);
      else follicularVals.push(display);
    }

    if (
      lutealVals.length < CROSSTAB_MIN_PRESENT_DAYS ||
      follicularVals.length < CROSSTAB_MIN_ABSENT_DAYS
    ) {
      continue;
    }

    const welch = welchTTest(lutealVals, follicularVals);
    const lutealAvg = lutealVals.reduce((s, v) => s + v, 0) / lutealVals.length;
    const follicularAvg =
      follicularVals.reduce((s, v) => s + v, 0) / follicularVals.length;
    const delta = lutealAvg - follicularAvg;
    if (delta === 0) continue;

    const pValue = welch.status === "ok" ? welch.pValue : 1;
    const minGroupDays = Math.min(lutealVals.length, follicularVals.length);

    candidates.push({
      row: {
        metricKey,
        display: cfg.display,
        lutealDays: lutealVals.length,
        follicularDays: follicularVals.length,
        lutealAvg: round(lutealAvg, 2),
        follicularAvg: round(follicularAvg, 2),
        delta: round(delta, 2),
        pValue,
        confidence: influenceConfidence(pValue, minGroupDays),
      },
    });
  }

  if (candidates.length === 0) return [];

  // One BH family across every metric tested — the same step-up the mood
  // crosstab + discovery engine run.
  const qValues = fdrAdjust(candidates.map((c) => c.row.pValue));

  return candidates
    .map((c, i) => ({ ...c.row, qValue: Math.round(qValues[i] * 1000) / 1000 }))
    .filter((row) => row.pValue < 0.05 && row.qValue <= CROSSTAB_FDR_Q)
    .sort(
      (a, b) =>
        a.qValue - b.qValue ||
        Math.abs(b.delta) - Math.abs(a.delta) ||
        a.metricKey.localeCompare(b.metricKey),
    )
    .slice(0, CROSSTAB_MAX_ROWS);
}

/**
 * Build the continuous CYCLE_PHASE behaviour series for the lagged-Pearson
 * discovery matrix (mechanism B). One ordinal value per labelled day. The
 * caller folds this into `discoverCorrelations(series)` alongside the existing
 * behaviour/outcome channels — the engine is pure and parameterised over
 * `NamedSeries[]`, so this never touches the general (non-gated) route.
 */
export function buildPhaseDiscoverySeries(
  phaseByDay: Map<string, CyclePhase>,
): NamedSeries {
  const points: DailySeriesPoint[] = [];
  for (const [day, phase] of phaseByDay) {
    points.push({ day, value: PHASE_ORDINAL[phase] });
  }
  points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { key: CYCLE_PHASE_CHANNEL_KEY, role: "behaviour", points };
}

/**
 * Mechanism B — run the lagged-Pearson FDR discovery with the continuous
 * CYCLE_PHASE ordinal folded in as a behaviour channel against the outcome
 * metric series. Pure: the caller builds the per-day outcome series (from
 * `metricDayMap`) and passes the phase map. Reuses `discoverCorrelations`
 * verbatim — no new statistics, the same n ≥ 20 / p < 0.05 / BH-FDR gate the
 * general matrix enforces — but scoped to the cycle-gated route only, so the
 * phase channel never reaches the non-gated `/api/insights/correlations`.
 */
export function discoverPhaseCorrelations(args: {
  phaseByDay: Map<string, CyclePhase>;
  measurements: CrossMetricMeasurement[];
  userPriorityJson?: unknown;
  /**
   * The reader's locale. Each surviving row carries a finished `interpretation`
   * sentence that the cycle route serves straight to the client, so it has to
   * be written in the reader's language. Required — no default, because a
   * default is what let the metric page's driver line ship in English.
   */
  locale: Locale;
}): CorrelationDiscoveryResult {
  const { phaseByDay, measurements, locale } = args;
  const userPriorityJson = args.userPriorityJson ?? null;

  const phaseSeries = buildPhaseDiscoverySeries(phaseByDay);
  const outcomeSeries: NamedSeries[] = [];
  for (const [, cfg] of Object.entries(PHASE_CROSSTAB_METRICS)) {
    const byDay = metricDayMap(measurements, cfg.type, userPriorityJson);
    if (byDay.size === 0) continue;
    const points: DailySeriesPoint[] = [];
    for (const [day, value] of byDay) points.push({ day, value });
    points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    outcomeSeries.push({ key: cfg.type, role: "outcome", points });
  }

  return discoverCorrelations([phaseSeries, ...outcomeSeries], { locale });
}

/**
 * Pick the ONE headline phase insight for the v1.15.0 MVP card (research
 * §7.1): resting-heart-rate-by-phase first (near-daily, the highest-value,
 * most-reachable n), falling back to HRV-by-phase, then to the strongest
 * remaining FDR-surviving row. Returns null when nothing cleared the gate —
 * honest "still learning", never a fabricated headline.
 */
export function selectHeadlinePhaseRow(
  rows: PhaseMetricCrosstabRow[],
): PhaseMetricCrosstabRow | null {
  if (rows.length === 0) return null;
  return (
    rows.find((r) => r.metricKey === "restingHeartRate") ??
    rows.find((r) => r.metricKey === "heartRateVariability") ??
    rows[0]
  );
}
