import { describe, expect, it } from "vitest";

import {
  MOOD_DIMENSIONS,
  MOOD_DIMENSION_MAX,
  MOOD_DIMENSION_MIN,
  getMoodDimension,
  orientForComparison,
} from "@/lib/mood/dimensions";

describe("MOOD_DIMENSIONS", () => {
  it("carries the five level-A dimensions in capture order", () => {
    expect(MOOD_DIMENSIONS.map((d) => d.key)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
  });

  it("binds each dimension to its own column", () => {
    expect(MOOD_DIMENSIONS.map((d) => d.column)).toEqual([
      "moodA1",
      "stressA2",
      "energyA3",
      "connectionA4",
      "stabilityA5",
    ]);
    const columns = new Set(MOOD_DIMENSIONS.map((d) => d.column));
    expect(columns.size).toBe(MOOD_DIMENSIONS.length);
  });

  it("runs 0..10 on every dimension", () => {
    for (const d of MOOD_DIMENSIONS) {
      expect(d.min).toBe(MOOD_DIMENSION_MIN);
      expect(d.max).toBe(MOOD_DIMENSION_MAX);
    }
  });

  it("marks exactly one dimension inverse, and it is stress", () => {
    const inverse = MOOD_DIMENSIONS.filter((d) => d.inverse);
    expect(inverse.map((d) => d.key)).toEqual(["a2"]);
  });

  it("gives every dimension a distinct label and two distinct anchors", () => {
    const keys: string[] = [];
    for (const d of MOOD_DIMENSIONS) {
      expect(d.labelKey).toBe(`mood.dimension.${d.key}.label`);
      expect(d.lowAnchorKey).toBe(`mood.dimension.${d.key}.low`);
      expect(d.highAnchorKey).toBe(`mood.dimension.${d.key}.high`);
      keys.push(d.labelKey, d.lowAnchorKey, d.highAnchorKey);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("resolves a dimension by wire key and refuses anything else", () => {
    expect(getMoodDimension("a3")?.column).toBe("energyA3");
    expect(getMoodDimension("a6")).toBeUndefined();
    expect(getMoodDimension("moodA1")).toBeUndefined();
    expect(getMoodDimension("")).toBeUndefined();
  });
});

describe("orientForComparison", () => {
  const a1 = MOOD_DIMENSIONS[0];
  const a2 = MOOD_DIMENSIONS[1];

  it("leaves an upright dimension alone", () => {
    expect(orientForComparison(a1, 0)).toBe(0);
    expect(orientForComparison(a1, 7)).toBe(7);
    expect(orientForComparison(a1, 10)).toBe(10);
  });

  it("flips the inverse dimension around the scale", () => {
    expect(orientForComparison(a2, 0)).toBe(10);
    expect(orientForComparison(a2, 3)).toBe(7);
    expect(orientForComparison(a2, 10)).toBe(0);
  });

  it("answers null for an absent value rather than a neutral one", () => {
    expect(orientForComparison(a1, null)).toBeNull();
    expect(orientForComparison(a1, undefined)).toBeNull();
    expect(orientForComparison(a2, null)).toBeNull();
    expect(orientForComparison(a2, Number.NaN)).toBeNull();
  });
});
