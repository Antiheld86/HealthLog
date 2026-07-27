import { describe, it, expect } from "vitest";

import {
  VALUE_RANGES,
  measurementTypeEnum,
} from "@/lib/validations/measurement";
import {
  areAllNonNegativeMetrics,
  isNonNegativeMetric,
} from "@/lib/measurements/value-domain";
import { buildBaselineBand } from "@/lib/insights/derived/baseline";
import { computePaddedYDomain } from "@/lib/insights/chart-y-domain";

/**
 * GUARD — a non-negative metric's baseline `low` is never below zero.
 *
 * The step sub-page printed "your usual range is −5,595.6–13,387.6 steps"
 * because the band's lower edge is `median − k·MAD·scale` and nothing said a
 * step cannot be owed. The chart above it already refused a negative axis, so
 * the app held both answers at once.
 *
 * These assertions pin the fixed shape end to end: the fact is declared once
 * (the metric's plausibility floor), the band reads it, and the axis reads the
 * same one. A series engineered so the spread exceeds the median is the exact
 * condition that produced the reported sentence.
 */

/**
 * Median 10, MAD 10 → spread = 3 · 10 · 1.4826 ≈ 44.5, i.e. well past the
 * centre. The raw arithmetic edge is ≈ −34.5.
 */
const SPREAD_EXCEEDS_CENTRE = [0, 0, 0, 10, 20, 30, 40];

/** The two types whose declared floor is genuinely signed. */
const SIGNED_TYPES = ["ANS_CHARGE", "BODY_TEMPERATURE_DEVIATION"] as const;

describe("non-negative metric guard", () => {
  it("every MeasurementType declares a plausibility range", () => {
    // The range map is the home of the "can this be negative" fact. A type
    // missing from it answers "unknown" and silently loses the floor — and,
    // separately, passes any number at all through ingest validation.
    const missing = measurementTypeEnum.options.filter(
      (type) => VALUE_RANGES[type] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("classifies every type from its own declared floor", () => {
    for (const type of measurementTypeEnum.options) {
      expect(isNonNegativeMetric(type)).toBe(VALUE_RANGES[type].min >= 0);
    }
    for (const type of SIGNED_TYPES) {
      expect(isNonNegativeMetric(type)).toBe(false);
    }
    // An unnamed or unknown metric is "unknown", never "non-negative".
    expect(isNonNegativeMetric(null)).toBe(false);
    expect(isNonNegativeMetric("NOT_A_METRIC")).toBe(false);
    expect(areAllNonNegativeMetrics([])).toBe(false);
    expect(areAllNonNegativeMetrics(["ACTIVITY_STEPS", "ANS_CHARGE"])).toBe(
      false,
    );
  });

  it("never floors the baseline band below zero for a non-negative metric", () => {
    const nonNegative = measurementTypeEnum.options.filter((type) =>
      isNonNegativeMetric(type),
    );
    // Sanity: the sweep must actually cover the bulk of the catalogue.
    expect(nonNegative.length).toBeGreaterThan(60);

    for (const type of nonNegative) {
      const band = buildBaselineBand(SPREAD_EXCEEDS_CENTRE, type);
      expect(band, type).not.toBeNull();
      expect(band!.low, `${type} band low`).toBeGreaterThanOrEqual(0);
      // The dispersion itself stays unclamped — a deviation-in-σ calculation
      // reads `spread`, and flooring it would understate every excursion.
      expect(band!.spread, `${type} spread`).toBeGreaterThan(band!.center);
    }
  });

  it("reproduces the reported step sentence with a non-negative lower edge", () => {
    // Roughly the reported shape: a median around 4,000 steps with days near
    // zero, which is what pushed the MAD band past the origin.
    const dayMeans = [0, 120, 900, 4000, 6200, 9800, 11762];
    const band = buildBaselineBand(dayMeans, "ACTIVITY_STEPS");
    expect(band!.low).toBe(0);
    expect(band!.high).toBeGreaterThan(band!.center);
  });

  it("keeps the real lower edge for a metric that can genuinely be negative", () => {
    for (const type of SIGNED_TYPES) {
      const band = buildBaselineBand(SPREAD_EXCEEDS_CENTRE, type);
      expect(band!.low, type).toBeLessThan(0);
    }
    // No metric identity → no invented floor either.
    expect(buildBaselineBand(SPREAD_EXCEEDS_CENTRE, null)!.low).toBeLessThan(0);
  });

  it("gives the chart axis the same answer as the band", () => {
    // A derived overlay (trend line, moving average) can extrapolate a step
    // count below zero even though no observation ever was. The axis floors
    // it because the METRIC cannot be negative, not because the data was.
    const domain = computePaddedYDomain([-320, 1200, 8400], ["ACTIVITY_STEPS"]);
    expect(domain![0]).toBe(0);

    // A signed metric keeps its downward padding.
    const signed = computePaddedYDomain([-40, 5, 60], ["ANS_CHARGE"]);
    expect(signed![0]).toBeLessThan(0);

    // An anonymous series keeps the older data-derived behaviour: padding
    // that would dip under an all-positive series stops at 0, a series with
    // real negative values keeps the full downward padding.
    expect(computePaddedYDomain([0.2, 0.5])![0]).toBe(0);
    expect(computePaddedYDomain([-5, 3, 10])![0]).toBeLessThan(0);
  });
});
