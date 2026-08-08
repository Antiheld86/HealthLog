/**
 * `computeForecast` — the two floors a fit has to clear, and the refusals.
 *
 * The first floor is the ladder, on rated days. The second is the one this
 * file exists for: a complete-case matrix can shrink well below the rated-day
 * count, because a day missing one of the fit's inputs is dropped rather than
 * imputed. An account with thirty rated days but a feature recorded on only
 * two thirds of them fits on twenty complete rows, and a forecast "built from
 * twenty days" past a floor that was supposed to mean thirty is a floor that
 * does not hold. The fit is refused below `MIN_ENTRIES_FOR_FORECAST` complete
 * rows, not only below thirty rated days.
 */
import { describe, expect, it } from "vitest";

import { computeForecast } from "../forecast";
import type { PrognosisDayInput } from "../features";
import { MIN_ENTRIES_FOR_FORECAST } from "../thresholds";

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

/**
 * `rated` days carrying a rating driven by A2, of which the most recent
 * `withFeature` actually carry the A2 slider. The rest are older face-only
 * days: rated, but with no input the fit can use, so they drop out of the
 * complete-case matrix. The feature sits on the RECENT days on purpose, so the
 * days the write window would score are scorable — otherwise the refusal is
 * "no recent day to score" rather than the "too few complete rows" this file
 * is about.
 */
function sparseDays(rated: number, withFeature: number): PrognosisDayInput[] {
  return Array.from({ length: rated }, (_, i) => {
    const stress = i % 11;
    const hasFeature = i >= rated - withFeature;
    return {
      day: dayKey(i),
      a1: Math.round(0.8 * (10 - stress) + 1),
      dimensions: hasFeature ? { a2: stress } : {},
      context: null,
      linked: { ...EMPTY_LINKED },
    };
  });
}

describe("computeForecast complete-row floor", () => {
  it("refuses a fit that clears the rated-day floor but not the complete-row one", () => {
    // 40 rated days, A2 on 25 of them: coverage 62.5% clears the candidate
    // floor, so A2 is screened in, but the complete-case matrix is 25 rows —
    // under the 30-row floor.
    const result = computeForecast(sparseDays(40, 25));
    expect(result.status, JSON.stringify(result)).toBe("refused");
  });

  it("writes once the complete rows themselves reach the floor", () => {
    // Every rated day carries the feature, so complete rows equal rated days.
    const result = computeForecast(sparseDays(40, 40));
    expect(result.status).toBe("written");
    if (result.status === "written") {
      expect(result.n).toBeGreaterThanOrEqual(MIN_ENTRIES_FOR_FORECAST);
    }
  });
});
