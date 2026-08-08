/**
 * The fit, and the one property that makes its band worth reading.
 *
 * The leakage case is the reason this file exists. A random k-fold over days
 * produces a model that scores beautifully and predicts nothing, and there is
 * nothing in the reported error that says so — which is why the assertion is
 * on the FOLD INDICES and on the day keys themselves rather than on the error.
 * An error-based check passes a leaking split whenever the leak happens to be
 * small, which is exactly when nobody would look.
 *
 * Watched red: the split was replaced with a shuffle, and
 * `describe("no training fold contains a day after its validation fold")`
 * went red naming a future day inside a training fold. Reverted, hash checked.
 */
import { describe, expect, it } from "vitest";

import { buildFeatureMatrix, type PrognosisDayInput } from "../features";
import { fitRidge, predictWithFit, solveLinearSystem } from "../ridge";
import {
  BAND_LOWER_QUANTILE,
  BAND_UPPER_QUANTILE,
  LAMBDA_GRID,
  MIN_VALIDATION_ROWS,
  MODEL_VERSION,
  fitPrognosisModel,
  quantile,
  rollingOriginFolds,
} from "../validate";

const EMPTY_LINKED = {
  sleepAsleep: null,
  steps: null,
  activeEnergy: null,
  restingHeartRate: null,
  heartRateVariability: null,
};

function dayKey(index: number): string {
  return new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
}

/** A deterministic pseudo-random series — a flaky statistics test is useless. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/**
 * Days whose target is a clean linear function of one dimension.
 *
 * One driver rather than two, and that is a statement about the screening
 * rather than about the fit: the screening is univariate, so a feature that
 * only matters jointly with another is refused before the fit ever sees it.
 * A two-driver fixture measures that property, not this one.
 */
function linearDays(count: number): PrognosisDayInput[] {
  return Array.from({ length: count }, (_, i) => {
    const stress = i % 11;
    return {
      day: dayKey(i),
      // 0.8 × up-is-better stress, plus one — inside the 0-10 scale.
      a1: 0.8 * (10 - stress) + 1,
      dimensions: { a2: stress, a3: (i * 7) % 11 },
      context: null,
      linked: { ...EMPTY_LINKED },
    };
  });
}

/** Days whose target is noise and whose inputs are unrelated noise. */
function noisyDays(count: number, seed = 7): PrognosisDayInput[] {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, i) => ({
    day: dayKey(i),
    a1: Math.round(random() * 10),
    dimensions: {
      a2: Math.round(random() * 10),
      a3: Math.round(random() * 10),
    },
    context: null,
    linked: { ...EMPTY_LINKED },
  }));
}

describe("no training fold contains a day after its validation fold", () => {
  const ROWS = 60;
  const folds = rollingOriginFolds(ROWS);

  it("produces folds at all — the assertions below pass on an empty list", () => {
    expect(folds.length).toBeGreaterThan(0);
    expect(folds.length).toBeLessThanOrEqual(4);
    // Every validation row is covered exactly once and the last fold reaches
    // the end, so no day is silently dropped from the measurement.
    expect(folds[folds.length - 1].validationEnd).toBe(ROWS);
  });

  it("trains on a prefix that ends exactly where the validation starts", () => {
    for (const fold of folds) {
      expect(fold.trainEnd).toBe(fold.validationStart);
      expect(fold.trainEnd).toBeGreaterThan(0);
      expect(fold.validationEnd).toBeGreaterThan(fold.validationStart);
    }
  });

  it("holds on the day keys, not just on the indices", () => {
    // The indices are only meaningful because the matrix is time-ordered, so
    // the property is asserted against the dates the rows actually carry.
    const matrix = buildFeatureMatrix(linearDays(ROWS));
    expect(matrix).not.toBeNull();
    if (!matrix) return;

    for (const fold of rollingOriginFolds(matrix.rows.length)) {
      const trainingDays = matrix.days.slice(0, fold.trainEnd);
      const validationDays = matrix.days.slice(
        fold.validationStart,
        fold.validationEnd,
      );
      const latestTrainingDay = trainingDays[trainingDays.length - 1];
      const earliestValidationDay = validationDays[0];
      const leaked = trainingDays.filter((d) => d >= earliestValidationDay);
      expect(
        leaked,
        `a training fold holds ${leaked.length} day(s) dated at or after the validation fold that starts on ${earliestValidationDay}`,
      ).toEqual([]);
      expect(latestTrainingDay < earliestValidationDay).toBe(true);
    }
  });

  it("expands rather than slides — later folds train on more history", () => {
    const sizes = folds.map((f) => f.trainEnd);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it("refuses to split a window too short to measure anything on", () => {
    expect(rollingOriginFolds(MIN_VALIDATION_ROWS - 1)).toEqual([]);
  });
});

describe("the ridge solve", () => {
  it("recovers the coefficients of a clean linear signal", () => {
    // y = 2*x1 - 3*x2, standardised columns, tiny penalty.
    const rows: number[][] = [];
    const targets: number[] = [];
    for (let i = 0; i < 40; i++) {
      const x1 = ((i % 7) - 3) / 2;
      const x2 = ((i % 5) - 2) / 1.5;
      rows.push([x1, x2]);
      targets.push(2 * x1 - 3 * x2 + 5);
    }
    const fit = fitRidge(rows, targets, 1e-6);
    expect(fit).not.toBeNull();
    if (!fit) return;
    expect(fit.coefficients[0]).toBeCloseTo(2, 2);
    expect(fit.coefficients[1]).toBeCloseTo(-3, 2);
    // The intercept is the mean of the training targets, and the columns are
    // centred against their own means, so a row at the column means predicts
    // the average day exactly.
    expect(predictWithFit(fit, fit.columnMeans)).toBeCloseTo(fit.intercept, 6);
    // And every training row is predicted back to its own target.
    rows.forEach((row, i) => {
      expect(predictWithFit(fit, row)).toBeCloseTo(targets[i], 2);
    });
  });

  it("does not divide by zero on a constant target", () => {
    const rows = Array.from({ length: 20 }, (_, i) => [i / 10, (i % 3) / 2]);
    const fit = fitRidge(rows, new Array(20).fill(4), 1);
    expect(fit).not.toBeNull();
    if (!fit) return;
    expect(fit.coefficients.every(Number.isFinite)).toBe(true);
    expect(fit.intercept).toBe(4);
    expect(predictWithFit(fit, [0, 0])).toBeCloseTo(4, 6);
  });

  it("refuses a singular system rather than answering zeros", () => {
    // Two identical columns and no penalty: the system has no unique answer,
    // and a vector of zeros would look exactly like "these features do not
    // matter".
    expect(
      solveLinearSystem(
        [
          [1, 1],
          [1, 1],
        ],
        [1, 1],
      ),
    ).toBeNull();
  });

  it("penalises: a larger lambda pulls the coefficients towards zero", () => {
    const rows = Array.from({ length: 30 }, (_, i) => [((i % 7) - 3) / 2]);
    const targets = rows.map((r) => 4 * r[0] + 5);
    const light = fitRidge(rows, targets, 0.01);
    const heavy = fitRidge(rows, targets, 100);
    expect(light).not.toBeNull();
    expect(heavy).not.toBeNull();
    if (!light || !heavy) return;
    expect(Math.abs(heavy.coefficients[0])).toBeLessThan(
      Math.abs(light.coefficients[0]),
    );
  });
});

describe("the band reacts to how wrong the model is", () => {
  it("is narrow on a clean signal and wide on noise", () => {
    const clean = buildFeatureMatrix(linearDays(80));
    expect(clean).not.toBeNull();
    if (!clean) return;
    const cleanModel = fitPrognosisModel(clean);
    expect(cleanModel).not.toBeNull();
    if (!cleanModel) return;
    const cleanWidth = cleanModel.bandHigh - cleanModel.bandLow;

    // Noise cannot go through the screening — it is refused before a fit is
    // attempted, which is the stronger answer. So the band's reaction is
    // measured on the matrix directly, with the screening bypassed by handing
    // the fit a matrix built from the noisy targets and the clean columns.
    const noisy = buildFeatureMatrix(linearDays(80));
    expect(noisy).not.toBeNull();
    if (!noisy) return;
    const random = seeded(11);
    const noisyMatrix = {
      ...noisy,
      targets: noisy.targets.map(() => Math.round(random() * 10)),
    };
    const noisyModel = fitPrognosisModel(noisyMatrix);
    expect(noisyModel).not.toBeNull();
    if (!noisyModel) return;
    const noisyWidth = noisyModel.bandHigh - noisyModel.bandLow;

    expect(
      noisyWidth,
      "the band did not widen on noise — a confident wrong number is the failure this band exists to prevent",
    ).toBeGreaterThan(cleanWidth * 2);
    expect(cleanWidth).toBeLessThan(2);
  });

  it("refuses noise at the screening, before any fit is attempted", () => {
    expect(buildFeatureMatrix(noisyDays(80))).toBeNull();
  });

  it("takes the band from the validation residuals, at the stated quantiles", () => {
    const matrix = buildFeatureMatrix(linearDays(80));
    expect(matrix).not.toBeNull();
    if (!matrix) return;
    const model = fitPrognosisModel(matrix);
    expect(model).not.toBeNull();
    if (!model) return;
    expect(model.bandLow).toBeLessThanOrEqual(model.bandHigh);
    expect(BAND_LOWER_QUANTILE).toBe(0.1);
    expect(BAND_UPPER_QUANTILE).toBe(0.9);
    expect(model.n).toBe(matrix.rows.length);
    expect(model.modelVersion).toBe(MODEL_VERSION);
    expect(LAMBDA_GRID).toContain(model.fit.lambda);
    // Never zero: an unpenalised solve memorises the training days.
    expect(Math.min(...LAMBDA_GRID)).toBeGreaterThan(0);
  });

  it("quantile interpolates rather than rounding to a sample", () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
  });
});
