/**
 * The mood page's cross-metric correlations clear the same bar as every
 * other user-facing correlation surface.
 *
 * `significantPearsonCorrelation` was written for exactly this failure — its
 * own comment names a five-point r ≈ 0.7 fluke rendering as "stark" — and the
 * weight, blood-pressure and mood-status surfaces were moved onto it. The
 * mood page stayed on the plain `pearsonCorrelation` with its floor of five
 * pairs and no significance test, so the same five points that the other
 * surfaces refuse still painted a "strong" badge here.
 *
 * These assertions are about what the reader is told, not about which helper
 * is called: below the bar there is no coefficient to show, and the card is
 * handed a reason it can name instead of a blank.
 */
import { describe, expect, it } from "vitest";

import {
  computeMoodMetricCorrelation,
  type DailyPoint,
} from "@/lib/insights/mood-aggregates";

const NOW = new Date("2026-06-01T12:00:00.000Z");

/** One point per day-offset, values taken from the list in order. */
function series(values: number[]): DailyPoint[] {
  return values.map((value, i) => ({ dayOffset: i, value }));
}

describe("computeMoodMetricCorrelation — significance gate", () => {
  it("refuses a five-day strong-looking slope and says the pairs are too few", () => {
    const mood = series([1, 2, 3, 4, 5]);
    const metric = series([1, 2, 2, 4, 3]);

    const out = computeMoodMetricCorrelation(mood, metric, NOW);

    expect(out.n).toBe(5);
    // No coefficient reaches the card, so no strength band can be painted.
    expect(out.result).toBeNull();
    // ... and the card is told WHY, so it can say so rather than showing an
    // unexplained blank.
    expect(out.suppressed).toBe("insufficientPairs");
  });

  it("refuses twenty noisy days as not significant rather than as too few", () => {
    const ys = [5, 2, 7, 1, 6, 3, 8, 2, 5, 4, 6, 1, 7, 3, 5, 2, 6, 4, 5, 3];
    const mood = series(ys.map((_, i) => i));
    const metric = series(ys);

    const out = computeMoodMetricCorrelation(mood, metric, NOW);

    expect(out.n).toBe(20);
    expect(out.result).toBeNull();
    expect(out.suppressed).toBe("notSignificant");
  });

  it("surfaces twenty days of a real relationship", () => {
    const mood = series(Array.from({ length: 20 }, (_, i) => i));
    const metric = series(
      Array.from({ length: 20 }, (_, i) => i * 2 + (i % 2 === 0 ? 0.3 : -0.3)),
    );

    const out = computeMoodMetricCorrelation(mood, metric, NOW);

    expect(out.suppressed).toBeUndefined();
    expect(out.result).not.toBeNull();
    expect(out.result!.n).toBe(20);
    expect(out.result!.strength).toBe("stark");
  });

  it("reports no overlap as too few pairs, not as an insignificant finding", () => {
    const out = computeMoodMetricCorrelation(series([3, 4]), [], NOW);

    expect(out.n).toBe(0);
    expect(out.result).toBeNull();
    expect(out.suppressed).toBe("insufficientPairs");
  });
});
