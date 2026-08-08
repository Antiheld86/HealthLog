/**
 * One account's answer, computed and handed back as rows to write.
 *
 * Pure: it takes the days somebody logged and returns either the rows a pass
 * should store or a refusal with the reason. It does not touch the database,
 * and that is a boundary rather than a style — `MoodPrediction` has exactly
 * one writer, the refresh job, and a guard holds it there
 * (`src/__tests__/mood-prediction-write-surface-guard.test.ts`). Keeping the
 * arithmetic here and the write there is what lets the whole decision path be
 * tested without a container.
 *
 * **It refuses more often than it answers, and that is the design.** Too few
 * days, no feature that clears the screening, no recent day carrying every
 * feature the fit needs, a singular system — every one of them returns a
 * refusal and the account is left with no forecast at all. The surface then
 * says there is not enough to go on, which is true, instead of showing a
 * number built out of three days and a coincidence.
 */
import {
  buildFeatureMatrix,
  standardiseDay,
  type PrognosisDayInput,
} from "./features";
import { PROGNOSIS_WRITE_WINDOW_DAYS } from "./load";
import { featureContributions, predictWithFit } from "./ridge";
import { forecastGate } from "./thresholds";
import { fitPrognosisModel } from "./validate";

/** The lowest and highest value the target scale can express. */
export const TARGET_MIN = 0;
export const TARGET_MAX = 10;

/** One stored contribution: what a feature moved the expected value by. */
export interface FeatureContribution {
  feature: string;
  contribution: number;
}

/** One day's forecast, in the shape the row is written in. */
export interface ForecastRow {
  date: string;
  predicted: number;
  ciLow: number;
  ciHigh: number;
  n: number;
  modelVersion: string;
  /** Ordered by absolute contribution, largest first. */
  contributions: FeatureContribution[];
}

/** Why an account gets no forecast. Every one of these is a normal outcome. */
export type ForecastRefusal =
  /** Below the ladder's forecast threshold. */
  | "too-few-days"
  /** Nothing recorded often enough, or varied enough, to screen in. */
  | "no-pattern"
  /** A pattern, but no recent day carrying every feature it needs. */
  | "no-scorable-day";

export type ForecastResult =
  | {
      status: "written";
      rows: ForecastRow[];
      /** Complete days the fit used. The `n` every surface must show. */
      n: number;
      modelVersion: string;
      /** How wide the band came out, for the job's event only. */
      bandWidth: number;
      featureCount: number;
    }
  | { status: "refused"; reason: ForecastRefusal };

function clampToScale(value: number): number {
  return Math.min(TARGET_MAX, Math.max(TARGET_MIN, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Fit the account's window and score its most recent days.
 *
 * The ladder is read against the number of DAYS carrying a self-rating, which
 * is the number a person can see themselves growing. The `n` stored on each
 * row is the number of complete days the fit actually used, which can be
 * smaller — a day that is missing one of the fit's inputs cannot be part of
 * it. Both numbers are honest and they answer different questions; the one on
 * the surface beside the value is `n`, because that is what the value rests on.
 */
export function computeForecast(
  days: readonly PrognosisDayInput[],
  writeWindowDays: number = PROGNOSIS_WRITE_WINDOW_DAYS,
): ForecastResult {
  const rated = days.filter((d) => typeof d.a1 === "number");
  const gate = forecastGate(rated.length);
  if (!gate.present) return { status: "refused", reason: "too-few-days" };

  const matrix = buildFeatureMatrix(days);
  const model = matrix === null ? null : fitPrognosisModel(matrix);
  if (model === null) return { status: "refused", reason: "no-pattern" };

  const rows: ForecastRow[] = [];
  for (const day of rated.slice(-writeWindowDays)) {
    const standardised = standardiseDay(day, model.standardisation);
    // A day missing one of the fit's features cannot be scored, and nothing is
    // filled in for it. It simply has no forecast.
    if (standardised === null) continue;
    const raw = predictWithFit(model.fit, standardised);
    if (raw === null) continue;

    rows.push({
      date: day.day,
      predicted: round(clampToScale(raw), 2),
      // The band travels with the prediction and is clamped to the same scale:
      // a lower edge below zero would be a claim the scale cannot express.
      ciLow: round(clampToScale(raw + model.bandLow), 2),
      ciHigh: round(clampToScale(raw + model.bandHigh), 2),
      n: model.n,
      modelVersion: model.modelVersion,
      contributions: featureContributions(
        model.fit,
        model.features,
        standardised,
      )
        .filter((c) => Number.isFinite(c.contribution))
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .map((c) => ({
          feature: c.feature,
          contribution: round(c.contribution, 3),
        })),
    });
  }

  if (rows.length === 0) {
    return { status: "refused", reason: "no-scorable-day" };
  }

  return {
    status: "written",
    rows,
    n: model.n,
    modelVersion: model.modelVersion,
    bandWidth: round(model.bandHigh - model.bandLow, 2),
    featureCount: model.features.length,
  };
}
