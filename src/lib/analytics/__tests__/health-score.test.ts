import { describe, it, expect } from "vitest";
import {
  coefficientOfVariation,
  complianceRate,
  computeHealthScore,
  linearRegressionSlope,
  moodStability,
  weightTrendAlignment,
  type HealthScoreInput,
} from "../health-score";

/**
 * Build a 30-day mood series with a deterministic pattern. The helper
 * keeps the variance tractable by hand so test expectations don't drift.
 */
function moodEntries(scores: number[]): Array<{ date: string; score: number }> {
  return scores.map((score, i) => ({
    date: new Date(Date.UTC(2026, 4, i + 1)).toISOString(),
    score,
  }));
}

function weightSeries(values: number[]): Array<{ date: string; kg: number }> {
  return values.map((kg, i) => ({
    date: new Date(Date.UTC(2026, 4, i + 1)).toISOString(),
    kg,
  }));
}

// ── Pure helpers ─────────────────────────────────────────────────────

describe("linearRegressionSlope", () => {
  it("returns null for fewer than two points", () => {
    expect(linearRegressionSlope([])).toBeNull();
    expect(
      linearRegressionSlope([{ date: "2026-05-01T00:00:00Z", value: 80 }]),
    ).toBeNull();
  });

  it("detects a clean upward slope (units / day)", () => {
    const slope = linearRegressionSlope(
      weightSeries([80, 81, 82, 83, 84]).map((p) => ({
        date: p.date,
        value: p.kg,
      })),
    );
    expect(slope).not.toBeNull();
    expect(slope!).toBeCloseTo(1, 5);
  });

  it("detects a clean downward slope", () => {
    const slope = linearRegressionSlope(
      weightSeries([85, 84, 83, 82, 81]).map((p) => ({
        date: p.date,
        value: p.kg,
      })),
    );
    expect(slope!).toBeCloseTo(-1, 5);
  });
});

describe("coefficientOfVariation", () => {
  it("returns null for fewer than two values", () => {
    expect(coefficientOfVariation([])).toBeNull();
    expect(coefficientOfVariation([4])).toBeNull();
  });

  it("returns 0 for a constant series", () => {
    expect(coefficientOfVariation([4, 4, 4, 4])).toBe(0);
  });

  it("scales with relative spread", () => {
    const tight = coefficientOfVariation([4, 4, 4, 4, 5])!;
    const loose = coefficientOfVariation([1, 5, 1, 5, 1])!;
    expect(loose).toBeGreaterThan(tight);
  });
});

describe("weightTrendAlignment", () => {
  it("returns 100 when latest reading is inside the band", () => {
    const series = weightSeries([90, 88, 85, 80]);
    const result = weightTrendAlignment(series, { min: 78, max: 82 });
    expect(result).toBe(100);
  });

  it("returns >50 when above the band and trending down (closing the gap)", () => {
    const series = weightSeries([95, 94, 93, 92, 91]);
    const result = weightTrendAlignment(series, { min: 75, max: 80 });
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(50);
  });

  it("returns <50 when above the band and trending up (drifting away)", () => {
    const series = weightSeries([90, 91, 92, 93, 94]);
    const result = weightTrendAlignment(series, { min: 75, max: 80 });
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(50);
  });

  it("scores the bare trend (non-null) when the target is missing but ≥2 readings exist", () => {
    // No target → fall back to trend-only scoring instead of returning
    // null, so a height-less user with weight data gets a populated pillar.
    const result = weightTrendAlignment(
      weightSeries([80, 80.5, 81, 81.5]),
      null,
    );
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(0);
    expect(result!).toBeLessThanOrEqual(100);
  });

  it("anchors a flat trend at 75 when there is no target", () => {
    expect(weightTrendAlignment(weightSeries([80, 80, 80, 80]), null)).toBe(75);
  });

  it("rewards a gentle decline (>75) when there is no target", () => {
    const result = weightTrendAlignment(
      weightSeries([84, 83.5, 83, 82.5]),
      null,
    );
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(75);
  });

  it("penalises a sustained rise (<75) when there is no target", () => {
    const result = weightTrendAlignment(
      weightSeries([80, 81, 82, 83, 84]),
      null,
    );
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(75);
  });

  it("returns null with no target and fewer than two readings", () => {
    expect(weightTrendAlignment(weightSeries([80]), null)).toBeNull();
    expect(weightTrendAlignment([], null)).toBeNull();
  });

  it("returns null with fewer than two readings", () => {
    expect(
      weightTrendAlignment(weightSeries([80]), { min: 75, max: 80 }),
    ).toBeNull();
  });
});

describe("moodStability", () => {
  it("returns null for fewer than 5 entries", () => {
    expect(moodStability(moodEntries([4, 4, 4, 4]))).toBeNull();
  });

  it("returns 100 for a constant high-mood series", () => {
    expect(moodStability(moodEntries([5, 5, 5, 5, 5, 5]))).toBe(100);
  });

  it("scores tight variance higher than loose variance", () => {
    const tight = moodStability(moodEntries([4, 4, 4, 4, 4, 5]))!;
    const loose = moodStability(moodEntries([1, 5, 1, 5, 1, 5]))!;
    expect(tight).toBeGreaterThan(loose);
  });
});

describe("complianceRate", () => {
  it("returns null for an empty list", () => {
    expect(complianceRate([])).toBeNull();
  });

  it("returns the rounded mean of compliance percentages", () => {
    expect(complianceRate([100, 80, 60])).toBe(80);
  });
});

// ── Composite scenarios ──────────────────────────────────────────────

describe("computeHealthScore — strong positive case", () => {
  it("lands in the green band (>=75)", () => {
    const input: HealthScoreInput = {
      bpInTargetRate: 90,
      weightSeriesLast30d: weightSeries([80, 79.5, 79, 78.5, 78]),
      weightTarget: { min: 76, max: 80 },
      weightTargetSource: "user",
      moodEntriesLast30d: moodEntries([4, 4, 5, 4, 5, 4, 5, 4, 4]),
      medicationCompliance30: [95, 100, 90],
    };
    const result = computeHealthScore(input);
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.band).toBe("green");
    expect(result.components.bp.value).toBe(90);
    expect(result.components.compliance.value).toBe(95);
  });
});

describe("computeHealthScore — mixed case", () => {
  it("lands in the yellow band (50..74)", () => {
    const input: HealthScoreInput = {
      bpInTargetRate: 60,
      // Above the band, drifting up — alignment <50.
      weightSeriesLast30d: weightSeries([85, 86, 87, 88]),
      weightTarget: { min: 78, max: 82 },
      weightTargetSource: "user",
      moodEntriesLast30d: moodEntries([2, 3, 5, 1, 4, 3]),
      medicationCompliance30: [100, 100],
    };
    const result = computeHealthScore(input);
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.score).toBeLessThan(75);
    expect(result.band).toBe("yellow");
  });
});

describe("computeHealthScore — poor case", () => {
  it("lands in the red band (<50)", () => {
    const input: HealthScoreInput = {
      bpInTargetRate: 20,
      weightSeriesLast30d: weightSeries([95, 96, 97, 98, 99]),
      weightTarget: { min: 78, max: 82 },
      weightTargetSource: "user",
      moodEntriesLast30d: moodEntries([1, 5, 1, 5, 1, 5]),
      medicationCompliance30: [40, 30, 20],
    };
    const result = computeHealthScore(input);
    expect(result.score).toBeLessThan(50);
    expect(result.band).toBe("red");
  });
});

describe("computeHealthScore — null component redistribution", () => {
  it("redistributes weights when bp is null", () => {
    const input: HealthScoreInput = {
      bpInTargetRate: null,
      weightSeriesLast30d: weightSeries([80, 80, 80, 80]),
      weightTarget: { min: 78, max: 82 },
      weightTargetSource: "user",
      moodEntriesLast30d: moodEntries([5, 5, 5, 5, 5]),
      medicationCompliance30: [100, 100],
    };
    const result = computeHealthScore(input);
    // bp weight 0; remaining base weights sum 0.7. Each scales by /0.7.
    expect(result.components.bp.weight).toBe(0);
    expect(result.components.weight.weight).toBeCloseTo(0.2 / 0.7, 5);
    expect(result.components.mood.weight).toBeCloseTo(0.2 / 0.7, 5);
    expect(result.components.compliance.weight).toBeCloseTo(0.3 / 0.7, 5);
    // Score should be 100 (every present component at 100).
    expect(result.score).toBe(100);
  });

  it("handles bp + mood both null — weight + compliance carry the score", () => {
    const input: HealthScoreInput = {
      bpInTargetRate: null,
      weightSeriesLast30d: weightSeries([80, 80, 80]),
      weightTarget: { min: 78, max: 82 },
      weightTargetSource: "user",
      // <5 mood entries → moodStability returns null.
      moodEntriesLast30d: moodEntries([4, 4]),
      medicationCompliance30: [80],
    };
    const result = computeHealthScore(input);
    expect(result.components.bp.value).toBeNull();
    expect(result.components.mood.value).toBeNull();
    // Remaining base weights sum 0.5; weight + compliance scale to 0.4 + 0.6.
    expect(result.components.weight.weight).toBeCloseTo(0.4, 5);
    expect(result.components.compliance.weight).toBeCloseTo(0.6, 5);
    // weight 100 (in-band) * 0.4 + compliance 80 * 0.6 = 40 + 48 = 88.
    expect(result.score).toBe(88);
  });

  it("handles all null except compliance — score equals complianceRate", () => {
    const input: HealthScoreInput = {
      bpInTargetRate: null,
      weightSeriesLast30d: [],
      weightTarget: null,
      weightTargetSource: "none",
      moodEntriesLast30d: [],
      medicationCompliance30: [73],
    };
    const result = computeHealthScore(input);
    expect(result.components.compliance.weight).toBeCloseTo(1, 5);
    expect(result.score).toBe(73);
    expect(result.band).toBe("yellow");
  });

  it("returns score 0 when every component is null", () => {
    const input: HealthScoreInput = {
      bpInTargetRate: null,
      weightSeriesLast30d: [],
      weightTarget: null,
      weightTargetSource: "none",
      moodEntriesLast30d: [],
      medicationCompliance30: [],
    };
    const result = computeHealthScore(input);
    expect(result.score).toBe(0);
    expect(result.band).toBe("red");
    for (const key of ["bp", "weight", "mood", "compliance"] as const) {
      expect(result.components[key].value).toBeNull();
      expect(result.components[key].weight).toBe(0);
    }
  });
});

describe("computeHealthScore — determinism", () => {
  const input: HealthScoreInput = {
    bpInTargetRate: 75,
    weightSeriesLast30d: weightSeries([82, 81, 80, 79]),
    weightTarget: { min: 76, max: 80 },
    weightTargetSource: "user",
    moodEntriesLast30d: moodEntries([4, 5, 3, 4, 5, 4]),
    medicationCompliance30: [85, 90, 80],
  };

  it("same input → same output", () => {
    const a = computeHealthScore(input);
    const b = computeHealthScore(input);
    expect(b).toEqual(a);
  });

  // v1.4.25 Fix-G — the legacy fallback used to be `new Date()`, which
  // made `asOf` drift by a millisecond between consecutive calls and
  // turned the determinism guard above into a flake on loaded runners.
  // The synthesised window-end now derives from input dates, not wall
  // clock, so the entire result is byte-identical across calls.
  it("derives a deterministic asOf for present components when attribution is omitted", () => {
    const a = computeHealthScore(input);
    const b = computeHealthScore(input);
    expect(b.components.bp.asOf).toBe(a.components.bp.asOf);
    expect(b.components.weight.asOf).toBe(a.components.weight.asOf);
    expect(b.components.mood.asOf).toBe(a.components.mood.asOf);
    expect(b.components.compliance.asOf).toBe(a.components.compliance.asOf);
  });
});

describe("computeHealthScore — delta vs previous week", () => {
  const baseInput: HealthScoreInput = {
    bpInTargetRate: 80,
    weightSeriesLast30d: weightSeries([82, 81, 80]),
    weightTarget: { min: 78, max: 82 },
    weightTargetSource: "user",
    moodEntriesLast30d: moodEntries([5, 4, 5, 4, 5]),
    medicationCompliance30: [100, 100],
  };
  const previousInput: HealthScoreInput = {
    ...baseInput,
    bpInTargetRate: 60,
    medicationCompliance30: [70, 80],
  };

  it("returns null when no previous input is supplied", () => {
    const result = computeHealthScore(baseInput);
    expect(result.delta).toBeNull();
  });

  it("returns positive delta when current is higher than previous", () => {
    const result = computeHealthScore(baseInput, previousInput);
    expect(result.delta).not.toBeNull();
    expect(result.delta!).toBeGreaterThan(0);
  });

  it("returns negative delta when current is lower than previous", () => {
    const result = computeHealthScore(previousInput, baseInput);
    expect(result.delta).not.toBeNull();
    expect(result.delta!).toBeLessThan(0);
  });
});

// ── v1.4.25 W8e — per-component source attribution ──────────────────

describe("computeHealthScore — source attribution", () => {
  const WINDOW_END = "2026-05-14T12:00:00.000Z";
  const BP_LATEST = "2026-05-14T08:00:00.000Z";
  const WEIGHT_LATEST = "2026-05-13T18:00:00.000Z";
  const MOOD_LATEST = "2026-05-14T07:30:00.000Z";

  function baseInputWithAttribution(
    attribution: HealthScoreInput["attribution"],
  ): HealthScoreInput {
    return {
      bpInTargetRate: 90,
      weightSeriesLast30d: weightSeries([80, 80, 80]),
      weightTarget: { min: 78, max: 82 },
      weightTargetSource: "user",
      moodEntriesLast30d: moodEntries([5, 4, 5, 4, 5]),
      medicationCompliance30: [95, 100],
      attribution,
    };
  }

  it("collapses a single-source component to that source label", () => {
    const result = computeHealthScore(
      baseInputWithAttribution({
        bpSources: ["withings"],
        asOfBp: BP_LATEST,
        weightSources: ["withings"],
        asOfWeight: WEIGHT_LATEST,
        moodSources: ["manual"],
        asOfMood: MOOD_LATEST,
        complianceSources: ["manual"],
        asOfCompliance: WINDOW_END,
        windowEndAt: WINDOW_END,
      }),
    );

    expect(result.components.bp.source).toBe("withings");
    expect(result.components.bp.asOf).toBe(BP_LATEST);
    expect(result.components.weight.source).toBe("withings");
    expect(result.components.weight.asOf).toBe(WEIGHT_LATEST);
    expect(result.components.mood.source).toBe("manual");
    expect(result.components.mood.asOf).toBe(MOOD_LATEST);
    expect(result.components.compliance.source).toBe("manual");
  });

  it("marks a component `mixed` when multiple sources contribute", () => {
    const result = computeHealthScore(
      baseInputWithAttribution({
        bpSources: ["withings", "manual"],
        asOfBp: BP_LATEST,
        weightSources: ["withings", "appleHealth"],
        asOfWeight: WEIGHT_LATEST,
        moodSources: ["manual"],
        asOfMood: MOOD_LATEST,
        complianceSources: ["manual"],
        asOfCompliance: WINDOW_END,
        windowEndAt: WINDOW_END,
      }),
    );

    expect(result.components.bp.source).toBe("mixed");
    expect(result.components.weight.source).toBe("mixed");
    // Single-source components still resolve to their token.
    expect(result.components.mood.source).toBe("manual");
  });

  it("falls through to `none` + window-end asOf when a component has no value", () => {
    const input: HealthScoreInput = {
      bpInTargetRate: null,
      weightSeriesLast30d: [],
      weightTarget: null,
      weightTargetSource: "none",
      // <5 mood entries → moodStability returns null.
      moodEntriesLast30d: moodEntries([4, 4]),
      medicationCompliance30: [],
      attribution: {
        bpSources: [],
        asOfBp: null,
        weightSources: [],
        asOfWeight: null,
        moodSources: [],
        asOfMood: null,
        complianceSources: [],
        asOfCompliance: null,
        windowEndAt: WINDOW_END,
      },
    };
    const result = computeHealthScore(input);
    expect(result.components.bp.source).toBe("none");
    expect(result.components.bp.asOf).toBe(WINDOW_END);
    expect(result.components.weight.source).toBe("none");
    expect(result.components.mood.source).toBe("none");
    expect(result.components.compliance.source).toBe("none");
  });

  it("backward-compat: omitted attribution defaults present components to `manual`", () => {
    const result = computeHealthScore({
      bpInTargetRate: 80,
      weightSeriesLast30d: weightSeries([80, 80, 80]),
      weightTarget: { min: 78, max: 82 },
      weightTargetSource: "user",
      moodEntriesLast30d: moodEntries([5, 5, 5, 5, 5]),
      medicationCompliance30: [100],
    });
    // No `attribution` supplied — the legacy contract had no source
    // field, so the helper defaults present components to "manual".
    expect(result.components.bp.source).toBe("manual");
    expect(result.components.weight.source).toBe("manual");
    expect(result.components.mood.source).toBe("manual");
    expect(result.components.compliance.source).toBe("manual");
    // The asOf falls back to a wall-clock ISO string — just verify the
    // type/shape, not the exact value.
    expect(typeof result.components.bp.asOf).toBe("string");
  });

  it("falls back to window-end asOf when a present component has no asOf supplied", () => {
    const result = computeHealthScore({
      bpInTargetRate: 90,
      weightSeriesLast30d: weightSeries([80, 80, 80]),
      weightTarget: { min: 78, max: 82 },
      weightTargetSource: "user",
      moodEntriesLast30d: moodEntries([5, 5, 5, 5, 5]),
      medicationCompliance30: [100],
      attribution: {
        bpSources: ["withings"],
        asOfBp: null,
        windowEndAt: WINDOW_END,
      },
    });
    expect(result.components.bp.source).toBe("withings");
    // No asOf supplied → fall back to window end.
    expect(result.components.bp.asOf).toBe(WINDOW_END);
  });
});

/**
 * v1.34 — the weight yardstick.
 *
 * Until this release the pillar graded every account with a height on file
 * against `22 x height^2` +/- 2 kg: a band nobody set and no surface named.
 * These pin the replacement contract — the band arrives whole from the caller,
 * a missing band scores the bare trend, and the result says which of the two
 * happened.
 */
describe("computeHealthScore — weight yardstick", () => {
  const stable = weightSeries([80, 80, 80, 80]);

  function scoreWeightOnly(
    series: Array<{ date: string; kg: number }>,
    target: { min: number; max: number } | null,
  ) {
    return computeHealthScore({
      bpInTargetRate: null,
      weightSeriesLast30d: series,
      weightTarget: target,
      weightTargetSource: target ? "user" : "none",
      moodEntriesLast30d: [],
      medicationCompliance30: [],
    });
  }

  it("takes the band whole — no expansion of the caller's bounds", () => {
    // 80 kg sits OUTSIDE 76-79. A +/- 2 kg widening would pull it in and
    // score 100; the band must be used exactly as handed over.
    expect(
      scoreWeightOnly(stable, { min: 76, max: 79 }).components.weight.value,
    ).toBe(50);
    // The same reading INSIDE the band scores the in-band 100.
    expect(
      scoreWeightOnly(stable, { min: 78, max: 82 }).components.weight.value,
    ).toBe(100);
  });

  it("scores the bare trend when no target is set", () => {
    // Stable weight, no target: the trend-only anchor, not the target-aware
    // "neither" midpoint of 50, and never a fabricated band.
    const result = scoreWeightOnly(stable, null);
    expect(result.components.weight.value).toBe(75);
    expect(result.components.weight.weight).toBeGreaterThan(0);
  });

  it("carries the resolved yardstick on the weight component", () => {
    const withTarget = scoreWeightOnly(stable, { min: 78, max: 82 });
    expect(withTarget.components.weight.targetSource).toBe("user");
    expect(withTarget.components.weight.target).toEqual({ min: 78, max: 82 });

    const without = scoreWeightOnly(stable, null);
    expect(without.components.weight.targetSource).toBe("none");
    expect(without.components.weight.target).toBeNull();
  });

  it("never reports a band when the source is `none`", () => {
    // Defensive: a caller that passes a band while declaring no source must
    // not have that band surface as though the user had set it.
    const result = computeHealthScore({
      bpInTargetRate: null,
      weightSeriesLast30d: stable,
      weightTarget: { min: 78, max: 82 },
      weightTargetSource: "none",
      moodEntriesLast30d: [],
      medicationCompliance30: [],
    });
    expect(result.components.weight.target).toBeNull();
    expect(result.components.weight.targetSource).toBe("none");
  });
});
