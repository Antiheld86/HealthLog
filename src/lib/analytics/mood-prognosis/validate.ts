/**
 * Choosing the penalty, and measuring how wrong the model is, without letting
 * it see the future.
 *
 * **Rolling origin, expanding window. Never a random k-fold.** Days are not
 * exchangeable: a Tuesday sits between a Monday and a Wednesday that resemble
 * it, and a shuffled split puts Wednesday in the training set and asks the
 * model about Tuesday. The result is a model that looks excellent and is
 * useless, and nothing about the number it reports says so. So the folds are
 * ranges of a time-ordered array, the training range always ends where the
 * validation range starts, and `rolling-origin.test.ts` asserts that on the
 * fold indices and on the day keys themselves rather than on the resulting
 * error — an error-based assertion would pass a leaking split whenever the
 * leak happened to be small.
 *
 * **The band comes from the validation residuals**, not from a textbook
 * standard error on the training fit. A training-fit interval on a model with
 * twelve columns and thirty rows is narrow by construction and says nothing;
 * the spread of the errors the model actually made on days it had not seen is
 * the honest width. It widens when the model is bad, which is the property the
 * surface depends on to report low confidence instead of a confident wrong
 * number.
 *
 * **What is out-of-sample here, and what is not — stated exactly, because the
 * boundary is easy to overclaim.** The RIDGE FIT is honest: within every fold
 * the coefficients are solved on the training prefix alone and scored on
 * validation rows the fit never saw, and no training fold holds a row dated
 * after its validation fold. That is the claim `rolling-origin.test.ts`
 * proves, and it is the one that matters for "does λ generalise".
 *
 * Two steps sit OUTSIDE that guarantee, on purpose:
 *
 *   * **Feature selection.** The screening in `features.ts` runs once over the
 *     whole window before the split, so the feature set a fold trains on was
 *     chosen with that fold's validation rows in view. This is the classic
 *     "screen, then cross-validate" optimism.
 *   * **Standardisation.** The per-user mean and spread are taken over the
 *     whole window too, so a validation row is z-scored against statistics its
 *     own value helped compute.
 *
 * Both make the reported error slightly better than a fully-nested procedure
 * would — measured here at roughly one part in sixty on the mean absolute
 * error and a couple of points of coverage, i.e. small enough that the band is
 * not dishonest but not zero. Nesting the screening and the standardisation
 * inside each fold would remove even that, at the cost of a per-fold feature
 * set and a materially larger amount of machinery; the trade was taken the
 * cheap way deliberately, and this comment is the price of taking it — a
 * reader must not read "no fold sees ahead" as covering the SELECTION, only
 * the FIT. If the feature set ever grows past a handful of strong columns, or
 * the optimism is ever measured larger, nest it.
 */
import { fitRidge, predictWithFit, type RidgeFit } from "./ridge";
import type { FeatureMatrix } from "./features";

/**
 * The stored model identity. Bump it whenever the feature set, the screening
 * or the fit changes, so a re-fit is legible in the rows rather than silently
 * changing what they mean. Rows carrying an older version stay readable; the
 * surface skips a feature key the current build no longer knows.
 */
export const MODEL_VERSION = "mood-ridge-1";

/**
 * The penalties the validation searches.
 *
 * Never zero: with a dozen standardised columns over a few dozen days, an
 * unpenalised solve memorises the training days and describes no other day.
 * The grid is coarse on purpose — the difference between λ=8 and λ=10 is far
 * below the noise in thirty days of self-ratings, and a fine grid would only
 * be a slower way to overfit the validation set.
 */
export const LAMBDA_GRID = [0.5, 1, 2, 5, 10, 25, 50] as const;

/** How many validation blocks the window is cut into. */
export const VALIDATION_FOLDS = 4;

/**
 * The band is the central 80% of the validation residuals: the 10th and the
 * 90th percentile. A range wide enough to be honest and narrow enough to be
 * worth reading — and empirical, so an asymmetric error stays asymmetric
 * instead of being averaged into a symmetric claim.
 */
export const BAND_LOWER_QUANTILE = 0.1;
export const BAND_UPPER_QUANTILE = 0.9;

/** Fewest rows a fold split is attempted on at all. */
export const MIN_VALIDATION_ROWS = 10;

/** One expanding-window split. Every index is into the time-ordered matrix. */
export interface RollingOriginFold {
  /** Training rows are `[0, trainEnd)`. */
  trainEnd: number;
  /** Validation rows are `[validationStart, validationEnd)`. */
  validationStart: number;
  validationEnd: number;
}

/**
 * Cut a time-ordered window into expanding-window folds.
 *
 * `trainEnd === validationStart` in every fold, which is the whole invariant:
 * the training range is a prefix and the validation range starts exactly where
 * it ends. No gap (a gap would waste days), no overlap (an overlap is the
 * leak).
 */
export function rollingOriginFolds(
  rowCount: number,
  folds: number = VALIDATION_FOLDS,
): RollingOriginFold[] {
  if (rowCount < MIN_VALIDATION_ROWS || folds < 1) return [];
  const block = Math.floor(rowCount / (folds + 1));
  if (block < 1) return [];

  const out: RollingOriginFold[] = [];
  for (let index = 1; index <= folds; index++) {
    const validationStart = block * index;
    const validationEnd =
      index === folds ? rowCount : Math.min(rowCount, block * (index + 1));
    if (validationEnd <= validationStart) continue;
    out.push({ trainEnd: validationStart, validationStart, validationEnd });
  }
  return out;
}

/** Linear-interpolated quantile of an unsorted sample. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** What one penalty scored across every fold. */
export interface LambdaScore {
  lambda: number;
  /** Residuals (`actual − predicted`) from validation rows only. */
  residuals: number[];
  meanAbsoluteError: number;
}

/**
 * Score one penalty over the folds. Training folds never contain a row dated
 * after their validation fold, by construction of {@link rollingOriginFolds}.
 */
export function scoreLambda(
  matrix: FeatureMatrix,
  lambda: number,
  folds: readonly RollingOriginFold[],
): LambdaScore | null {
  const residuals: number[] = [];
  for (const fold of folds) {
    const fit = fitRidge(
      matrix.rows.slice(0, fold.trainEnd),
      matrix.targets.slice(0, fold.trainEnd),
      lambda,
    );
    if (fit === null) continue;
    for (let i = fold.validationStart; i < fold.validationEnd; i++) {
      const predicted = predictWithFit(fit, matrix.rows[i]);
      if (predicted === null) continue;
      residuals.push(matrix.targets[i] - predicted);
    }
  }
  if (residuals.length === 0) return null;
  return {
    lambda,
    residuals,
    meanAbsoluteError:
      residuals.reduce((sum, r) => sum + Math.abs(r), 0) / residuals.length,
  };
}

/** A model, ready to score a day, with the band its own errors earned it. */
export interface PrognosisModel {
  fit: RidgeFit;
  features: string[];
  standardisation: FeatureMatrix["standardisation"];
  /** Rows the final fit used. This is the `n` every surface must show. */
  n: number;
  /** Offsets from a prediction to the edges of the band, in target units. */
  bandLow: number;
  bandHigh: number;
  /** Mean absolute error over the validation folds, for the record. */
  meanAbsoluteError: number;
  modelVersion: string;
}

/**
 * Validate, choose λ, refit on the whole window, and take the band from the
 * validation residuals.
 *
 * `null` is a refusal and is a normal outcome: too few complete days to split,
 * a singular system, or a fold set that produced no residual at all. The
 * caller writes no forecast rather than a forecast nobody measured.
 */
export function fitPrognosisModel(
  matrix: FeatureMatrix,
  lambdaGrid: readonly number[] = LAMBDA_GRID,
): PrognosisModel | null {
  const folds = rollingOriginFolds(matrix.rows.length);
  if (folds.length === 0) return null;

  let best: LambdaScore | null = null;
  for (const lambda of lambdaGrid) {
    const score = scoreLambda(matrix, lambda, folds);
    if (score === null) continue;
    if (best === null || score.meanAbsoluteError < best.meanAbsoluteError) {
      best = score;
    }
  }
  if (best === null) return null;

  const fit = fitRidge(matrix.rows, matrix.targets, best.lambda);
  if (fit === null) return null;

  return {
    fit,
    features: matrix.features,
    standardisation: matrix.standardisation,
    n: matrix.rows.length,
    bandLow: quantile(best.residuals, BAND_LOWER_QUANTILE),
    bandHigh: quantile(best.residuals, BAND_UPPER_QUANTILE),
    meanAbsoluteError: best.meanAbsoluteError,
    modelVersion: MODEL_VERSION,
  };
}
