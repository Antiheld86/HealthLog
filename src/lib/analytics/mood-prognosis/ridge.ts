/**
 * Ridge regression, closed form, in about sixty lines of arithmetic.
 *
 * `(XᵀX + λI)β = Xᵀy`, solved by Gaussian elimination with partial pivoting.
 * That is the whole model. It is here rather than in a dependency because a
 * dozen standardised columns is a 12×12 system, and adding a package to solve
 * one of those would be adding a supply chain to avoid writing a loop.
 *
 * Two properties the rest of the feature relies on:
 *
 *   * **The intercept is not penalised, because there is no intercept in the
 *     system.** The target is centred before the solve and the mean is added
 *     back afterwards, which is the standard treatment: penalising the
 *     intercept would shrink every prediction towards zero rather than
 *     towards the person's own average day, and towards zero on a 0-10
 *     pleasantness scale means "towards the worst day imaginable".
 *   * **λ is never zero.** With more columns than the ridge penalty can
 *     afford, an unpenalised solve is a memoriser: it fits the training days
 *     perfectly and says nothing about any other day. The grid the validation
 *     searches starts above zero for that reason.
 *
 * This is arithmetic, not an AI surface. No provider, no consent gate, no
 * egress — see the note at the top of the refresh job.
 */

/** A fitted model: one coefficient per standardised column, plus the mean. */
export interface RidgeFit {
  /** One per column of the matrix it was fitted on, in the same order. */
  coefficients: number[];
  /** The mean of the training targets, added back on every prediction. */
  intercept: number;
  /**
   * The mean of each training column, subtracted before every prediction.
   *
   * Usually zero to floating point, because the matrix arrives z-scored. It is
   * carried anyway rather than assumed: centring the target while leaving the
   * columns uncentred biases every coefficient, and the bias is small enough
   * to look like rounding. Somebody handing this function a raw matrix should
   * get the right answer, not a plausible one.
   */
  columnMeans: number[];
  /** The penalty this fit used. */
  lambda: number;
}

/**
 * Solve `A x = b` by Gaussian elimination with partial pivoting.
 *
 * `null` when the system is singular to working precision. The caller treats
 * that as "no fit" rather than as a fit of zeros: a singular system means the
 * columns are telling the same story twice, and a zero vector would silently
 * become a model that predicts the average and calls it a pattern.
 */
export function solveLinearSystem(
  matrix: readonly number[][],
  vector: readonly number[],
): number[] | null {
  const n = vector.length;
  if (matrix.length !== n) return null;
  // Copy: the caller's XᵀX is reused across the λ grid and elimination is
  // destructive.
  const a = matrix.map((row, i) => [...row, vector[i]]);

  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-10) return null;
    if (pivot !== column) {
      const swap = a[pivot];
      a[pivot] = a[column];
      a[column] = swap;
    }
    const pivotValue = a[column][column];
    for (let row = column + 1; row < n; row++) {
      const factor = a[row][column] / pivotValue;
      if (factor === 0) continue;
      for (let k = column; k <= n; k++) a[row][k] -= factor * a[column][k];
    }
  }

  const solution = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = a[row][n];
    for (let k = row + 1; k < n; k++) sum -= a[row][k] * solution[k];
    solution[row] = sum / a[row][row];
  }
  return solution.every((v) => Number.isFinite(v)) ? solution : null;
}

/**
 * Fit `rows` against `targets` at one penalty.
 *
 * `rows` are already standardised per user (see `features.ts`), so the columns
 * are comparable and one λ is a defensible penalty across all of them —
 * which is not true of raw minutes beside a 0-10 rating.
 */
export function fitRidge(
  rows: readonly (readonly number[])[],
  targets: readonly number[],
  lambda: number,
): RidgeFit | null {
  const n = rows.length;
  if (n === 0 || targets.length !== n) return null;
  const columns = rows[0].length;
  if (columns === 0) return null;
  if (rows.some((row) => row.length !== columns)) return null;

  const intercept = targets.reduce((sum, v) => sum + v, 0) / n;
  const centredTargets = targets.map((v) => v - intercept);
  const columnMeans = Array.from({ length: columns }, (_, j) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rows[i][j];
    return sum / n;
  });
  const centredRows = rows.map((row) => row.map((v, j) => v - columnMeans[j]));

  const xtx: number[][] = Array.from({ length: columns }, () =>
    new Array<number>(columns).fill(0),
  );
  const xty = new Array<number>(columns).fill(0);
  for (let i = 0; i < n; i++) {
    const row = centredRows[i];
    for (let j = 0; j < columns; j++) {
      xty[j] += row[j] * centredTargets[i];
      for (let k = j; k < columns; k++) {
        const product = row[j] * row[k];
        xtx[j][k] += product;
        if (k !== j) xtx[k][j] += product;
      }
    }
  }
  for (let j = 0; j < columns; j++) xtx[j][j] += lambda;

  const coefficients = solveLinearSystem(xtx, xty);
  if (coefficients === null) return null;
  return { coefficients, intercept, columnMeans, lambda };
}

/** Score one standardised row. */
export function predictWithFit(
  fit: RidgeFit,
  row: readonly number[],
): number | null {
  if (row.length !== fit.coefficients.length) return null;
  let sum = fit.intercept;
  for (let i = 0; i < row.length; i++) {
    sum += fit.coefficients[i] * (row[i] - fit.columnMeans[i]);
  }
  return Number.isFinite(sum) ? sum : null;
}

/**
 * The per-feature contributions of one scored day.
 *
 * `coefficient × the day's standardised value`, which is what the stored
 * `features` column holds and what the explanation line is generated from.
 * Signed, so a feature that pulled the expected value down reads as having
 * pulled it down, and the parts sum to the distance between the prediction and
 * the person's own average day.
 */
export function featureContributions(
  fit: RidgeFit,
  featureKeys: readonly string[],
  row: readonly number[],
): Array<{ feature: string; contribution: number }> {
  return featureKeys.map((feature, index) => ({
    feature,
    contribution:
      fit.coefficients[index] * (row[index] - fit.columnMeans[index]),
  }));
}
