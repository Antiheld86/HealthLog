/**
 * The matrix: what becomes a column, what never does, and what happens to a
 * day that is missing something.
 *
 * The cases that matter are the absences. A day with no context row must not
 * contribute a zero to a work-status column, because zero there means "worked
 * a regular day and not overtime" and the truth is "nobody said". That
 * distinction is invisible in the fitted numbers and would quietly teach the
 * model that every unlogged day was a day off.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_MODEL_FEATURES,
  MIN_FEATURE_COVERAGE,
  buildFeatureMatrix,
  extractDayFeatures,
  screenFeatures,
  standardiseDay,
  type PrognosisContextInput,
  type PrognosisDayInput,
} from "../features";
import { MOOD_DIMENSIONS } from "@/lib/mood/dimensions";

const EMPTY_LINKED = {
  sleepAsleep: null,
  steps: null,
  activeEnergy: null,
  restingHeartRate: null,
  heartRateVariability: null,
};

function context(
  overrides: Partial<PrognosisContextInput> = {},
): PrognosisContextInput {
  return {
    workStatus: null,
    workMinutes: null,
    overtimeMinutes: null,
    workLoad: null,
    workSatisfaction: null,
    contactCircles: [],
    contactForm: null,
    contactExtent: null,
    contactQuality: null,
    contactSupport: null,
    leisureCategories: [],
    leisureMinutes: null,
    leisureJoy: null,
    leisureRecovery: null,
    eventType: null,
    eventValence: null,
    ...overrides,
  };
}

function day(
  index: number,
  overrides: Partial<PrognosisDayInput> = {},
): PrognosisDayInput {
  const date = new Date(Date.UTC(2026, 0, 1 + index));
  return {
    day: date.toISOString().slice(0, 10),
    a1: 5,
    dimensions: {},
    context: null,
    linked: { ...EMPTY_LINKED },
    ...overrides,
  };
}

describe("extractDayFeatures", () => {
  it("takes A2 through the dimension table's inverse flag, not inline", () => {
    const a2 = MOOD_DIMENSIONS.find((d) => d.key === "a2");
    expect(a2?.inverse, "A2 is the inverse dimension this case is about").toBe(
      true,
    );
    const features = extractDayFeatures(
      day(0, { dimensions: { a2: 8, a3: 8 } }),
    );
    // Stress 8 is a heavy day, so on an up-is-better axis it reads as 2.
    expect(features.get("dimension:a2")).toBe(2);
    // A3 is not inverse and is carried literally.
    expect(features.get("dimension:a3")).toBe(8);
  });

  it("never makes A1 an input", () => {
    const features = extractDayFeatures(
      day(0, { a1: 7, dimensions: { a1: 7, a2: 3 } }),
    );
    expect(features.has("dimension:a1")).toBe(false);
  });

  it("a day with no context contributes no context column at all", () => {
    const features = extractDayFeatures(day(0, { context: null }));
    expect(
      [...features.keys()].filter((k) => k.startsWith("context:")),
    ).toEqual([]);
  });

  it("an unanswered field contributes no column; an answered one contributes zeros and a one", () => {
    const answered = extractDayFeatures(
      day(0, { context: context({ workStatus: "overtime" }) }),
    );
    expect(answered.get("context:workStatus=overtime")).toBe(1);
    expect(answered.get("context:workStatus=off")).toBe(0);

    const unanswered = extractDayFeatures(
      day(0, { context: context({ workLoad: 4 }) }),
    );
    expect(unanswered.has("context:workStatus=overtime")).toBe(false);
    expect(unanswered.has("context:workStatus=off")).toBe(false);
    expect(unanswered.get("context:workLoad")).toBe(4);
  });

  it("a recorded zero is a value, and absence is absence", () => {
    const zero = extractDayFeatures(
      day(0, { linked: { ...EMPTY_LINKED, steps: 0 } }),
    );
    expect(zero.get("linked:steps")).toBe(0);
    const absent = extractDayFeatures(day(0));
    expect(absent.has("linked:steps")).toBe(false);
  });

  it("an empty multi-select says nothing rather than saying no to everything", () => {
    const features = extractDayFeatures(
      day(0, { context: context({ contactCircles: [] }) }),
    );
    expect(features.has("context:contactCircles=partner")).toBe(false);
  });
});

describe("screening", () => {
  /** A2 drives A1 exactly; everything else is constant or noise. */
  function drivenDays(count: number): PrognosisDayInput[] {
    return Array.from({ length: count }, (_, i) => {
      const stress = i % 11;
      return day(i, {
        // Up-is-better A2 is `10 - stress`, and the target follows it.
        a1: 10 - stress,
        dimensions: { a2: stress },
      });
    });
  }

  it("keeps a feature that tracks the target", () => {
    const screened = screenFeatures(drivenDays(40));
    const a2 = screened.find((s) => s.key === "dimension:a2");
    expect(a2?.selected, "a perfectly tracking feature was screened out").toBe(
      true,
    );
    expect(a2?.pairs).toBe(40);
  });

  it("refuses a feature recorded on too few of the days, before testing it", () => {
    const days = drivenDays(40);
    // Recorded on a quarter of the days — under the coverage floor whatever
    // it correlates with.
    const covered = Math.floor(40 * MIN_FEATURE_COVERAGE) - 5;
    for (let i = 0; i < covered; i++) {
      days[i] = { ...days[i], linked: { ...EMPTY_LINKED, steps: 1000 + i } };
    }
    const screened = screenFeatures(days);
    const steps = screened.find((s) => s.key === "linked:steps");
    expect(steps?.selected).toBe(false);
    expect(steps?.reason).toBe("coverage");
  });

  it("refuses a one-hot seen fewer times than the occurrence floor", () => {
    const days = drivenDays(40).map((d, i) => ({
      ...d,
      // Everybody worked; two days were overtime. The column is present on
      // every day, so coverage passes and the occurrence floor is what
      // refuses it.
      context: context({ workStatus: i < 2 ? "overtime" : "regular" }),
    }));
    const screened = screenFeatures(days);
    const overtime = screened.find(
      (s) => s.key === "context:workStatus=overtime",
    );
    expect(overtime?.selected).toBe(false);
    expect(overtime?.reason).toBe("occurrences");
  });

  it("refuses pure noise — the whole reason the FDR layer is here", () => {
    // A deterministic pseudo-random series, so the case cannot flake.
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const days = Array.from({ length: 60 }, (_, i) =>
      day(i, {
        a1: Math.round(random() * 10),
        dimensions: { a2: Math.round(random() * 10) },
        linked: { ...EMPTY_LINKED, steps: Math.round(random() * 10000) },
      }),
    );
    const selected = screenFeatures(days).filter((s) => s.selected);
    expect(selected.map((s) => s.key)).toEqual([]);
  });

  it("caps the column count", () => {
    expect(MAX_MODEL_FEATURES).toBe(12);
  });
});

describe("buildFeatureMatrix", () => {
  function drivenDays(count: number): PrognosisDayInput[] {
    return Array.from({ length: count }, (_, i) =>
      day(i, { a1: 10 - (i % 11), dimensions: { a2: i % 11 } }),
    );
  }

  it("standardises per user, so the columns are that person's own units", () => {
    const matrix = buildFeatureMatrix(drivenDays(40));
    expect(matrix).not.toBeNull();
    if (!matrix) return;
    const column = matrix.rows.map((row) => row[0]);
    const mean = column.reduce((s, v) => s + v, 0) / column.length;
    const sd = Math.sqrt(
      column.reduce((s, v) => s + (v - mean) * (v - mean), 0) / column.length,
    );
    expect(mean).toBeCloseTo(0, 6);
    expect(sd).toBeCloseTo(1, 6);
    // The standardisation is kept so a later day can be scored on the same
    // scale rather than re-standardised against itself.
    expect(matrix.standardisation[0].key).toBe(matrix.features[0]);
    expect(matrix.standardisation[0].sd).toBeGreaterThan(0);
  });

  it("orders rows oldest first, which is what makes the validation honest", () => {
    const matrix = buildFeatureMatrix(drivenDays(40));
    expect(matrix).not.toBeNull();
    if (!matrix) return;
    const sorted = [...matrix.days].sort();
    expect(matrix.days).toEqual(sorted);
  });

  it("drops a day that is missing a selected feature rather than filling it in", () => {
    const days = drivenDays(40);
    days[5] = { ...days[5], dimensions: {} };
    const matrix = buildFeatureMatrix(days);
    expect(matrix).not.toBeNull();
    if (!matrix) return;
    expect(matrix.days).not.toContain(days[5].day);
    expect(matrix.rows).toHaveLength(39);
    // Nothing was imputed in its place.
    expect(matrix.targets).toHaveLength(39);
  });

  it("refuses when nothing survives the screening", () => {
    const flat = Array.from({ length: 40 }, (_, i) => day(i, { a1: 5 }));
    expect(buildFeatureMatrix(flat)).toBeNull();
  });

  it("refuses a constant target instead of dividing by zero", () => {
    const constant = Array.from({ length: 40 }, (_, i) =>
      day(i, { a1: 5, dimensions: { a2: i % 7 } }),
    );
    expect(buildFeatureMatrix(constant)).toBeNull();
  });
});

describe("standardiseDay", () => {
  it("scores a day on the stored scale", () => {
    const row = standardiseDay(day(0, { dimensions: { a2: 5 } }), [
      { key: "dimension:a2", mean: 5, sd: 2 },
    ]);
    // Up-is-better A2 of a stress-5 day is 5, the mean, so zero.
    expect(row).toEqual([0]);
  });

  it("refuses a day missing one of the fit's features", () => {
    expect(
      standardiseDay(day(0, { dimensions: {} }), [
        { key: "dimension:a2", mean: 5, sd: 2 },
      ]),
    ).toBeNull();
  });
});
