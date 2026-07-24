import { describe, it, expect } from "vitest";

import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  invertDisplayTransform,
  getDisplayTransform,
  hasDisplayTransform,
  TRANSFORMED_TYPES,
  DEFAULT_UNIT_PREFERENCE,
} from "../display-transform";

describe("display-transform", () => {
  it("converts WALKING_SPEED m/s → km/h (factor 3.6)", () => {
    const t = getDisplayTransform("WALKING_SPEED", "metric");
    expect(t.factor).toBe(3.6);
    expect(t.displayUnit).toBe("km/h");
    expect(t.decimals).toBe(1);
    // 1.3 m/s → 4.68 km/h (1 dp → 4.7).
    const scaled = applyDisplayTransform(1.3, t);
    expect(scaled).toBeCloseTo(4.68, 5);
    expect(Number(scaled.toFixed(t.decimals))).toBe(4.7);
  });

  it("converts WALKING_RUNNING_DISTANCE m → km (factor 0.001)", () => {
    const t = getDisplayTransform("WALKING_RUNNING_DISTANCE", "metric");
    expect(t.factor).toBe(0.001);
    expect(t.displayUnit).toBe("km");
    expect(t.decimals).toBe(2);
    // 5000 m → 5.00 km.
    expect(applyDisplayTransform(5000, t)).toBeCloseTo(5, 5);
  });

  it("exposes imperial branches for speed + distance", () => {
    const speed = getDisplayTransform("WALKING_SPEED", "imperial");
    expect(speed.displayUnit).toBe("mph");
    // 1.34 m/s ≈ 3.0 mph.
    expect(applyDisplayTransform(1.34, speed)).toBeCloseTo(2.9975, 3);

    const dist = getDisplayTransform("WALKING_RUNNING_DISTANCE", "imperial");
    expect(dist.displayUnit).toBe("mi");
    // 1609.34 m ≈ 1 mile.
    expect(applyDisplayTransform(1609.344, dist)).toBeCloseTo(1, 3);
  });

  it("returns identity (factor 1) for untransformed types", () => {
    for (const type of [
      "PULSE",
      "WEIGHT",
      "RESPIRATORY_RATE",
      "AUDIO_EXPOSURE_ENV",
    ]) {
      const t = getDisplayTransform(type);
      expect(t.factor).toBe(1);
      // identity scale leaves the raw value untouched
      expect(applyDisplayTransform(42, t)).toBe(42);
    }
  });

  it("identity transform surfaces the canonical unit", () => {
    expect(getDisplayTransform("WEIGHT").displayUnit).toBe("kg");
    expect(getDisplayTransform("PULSE").displayUnit).toBe("bpm");
    expect(getDisplayTransform("WALKING_STEP_LENGTH").displayUnit).toBe("m");
  });

  it("defaults to the metric preference", () => {
    expect(DEFAULT_UNIT_PREFERENCE).toBe("metric");
    expect(getDisplayTransform("WALKING_SPEED")).toEqual(
      getDisplayTransform("WALKING_SPEED", "metric"),
    );
  });

  // ── v1.32.26 — weight-class / length / temperature registry ──

  it("converts WEIGHT kg → lb on the imperial branch", () => {
    const metric = getDisplayTransform("WEIGHT", "metric");
    expect(metric.factor).toBe(1);
    expect(metric.displayUnit).toBe("kg");
    // Metric is the identity on the number — byte-identical to storage.
    expect(applyDisplayTransform(95.25, metric)).toBe(95.25);

    const imperial = getDisplayTransform("WEIGHT", "imperial");
    expect(imperial.displayUnit).toBe("lb");
    // 95.25 kg → 210.0 lb.
    expect(applyDisplayTransform(95.25, imperial)).toBeCloseTo(210.0, 1);
  });

  it("shares the mass branch across every body-mass metric", () => {
    for (const type of [
      "TOTAL_BODY_WATER",
      "BONE_MASS",
      "FAT_MASS",
      "FAT_FREE_MASS",
      "MUSCLE_MASS",
      "LEAN_BODY_MASS",
      "GRIP_STRENGTH",
    ]) {
      expect(getDisplayTransform(type, "imperial").displayUnit).toBe("lb");
      expect(getDisplayTransform(type, "metric").displayUnit).toBe("kg");
      // 10 kg → 22.05 lb.
      expect(
        applyDisplayTransform(10, getDisplayTransform(type, "imperial")),
      ).toBeCloseTo(22.0462, 3);
    }
  });

  it("converts WAIST_CIRCUMFERENCE cm → in", () => {
    const imperial = getDisplayTransform("WAIST_CIRCUMFERENCE", "imperial");
    expect(imperial.displayUnit).toBe("in");
    // 84 cm → 33.07 in.
    expect(applyDisplayTransform(84, imperial)).toBeCloseTo(33.07, 2);
  });

  it("converts an ABSOLUTE temperature °C → °F affinely (factor + offset)", () => {
    const metric = getDisplayTransform("BODY_TEMPERATURE", "metric");
    expect(metric.displayUnit).toBe("°C");
    expect(metric.offset ?? 0).toBe(0);

    const imperial = getDisplayTransform("BODY_TEMPERATURE", "imperial");
    expect(imperial.displayUnit).toBe("°F");
    expect(imperial.factor).toBe(1.8);
    expect(imperial.offset).toBe(32);
    // 36.6 °C → 97.88 °F (the +32 shift MUST apply to an absolute reading).
    expect(applyDisplayTransform(36.6, imperial)).toBeCloseTo(97.88, 2);
    // 0 °C → 32 °F (not 0).
    expect(applyDisplayTransform(0, imperial)).toBe(32);
  });

  it("skin + wrist temperature share the affine temperature branch", () => {
    for (const type of ["SKIN_TEMPERATURE", "WRIST_TEMPERATURE"]) {
      const imperial = getDisplayTransform(type, "imperial");
      expect(imperial.displayUnit).toBe("°F");
      expect(imperial.offset).toBe(32);
    }
  });

  it("BODY_TEMPERATURE_DEVIATION scales °C→°F WITHOUT the offset (it is a Δ)", () => {
    const imperial = getDisplayTransform(
      "BODY_TEMPERATURE_DEVIATION",
      "imperial",
    );
    expect(imperial.displayUnit).toBe("°F");
    expect(imperial.factor).toBe(1.8);
    // A signed deviation is a delta: 1 Δ°C is a 1.8 Δ°F, NEVER 33.8 °F.
    expect(imperial.offset ?? 0).toBe(0);
    expect(applyDisplayTransform(1, imperial)).toBeCloseTo(1.8, 5);
  });

  it("the delta helper NEVER applies the affine offset", () => {
    const imperial = getDisplayTransform("BODY_TEMPERATURE", "imperial");
    // Same absolute transform (offset 32), but a delta must be factor-only.
    expect(applyDisplayTransform(1, imperial)).toBe(33.8);
    expect(applyDisplayTransformDelta(1, imperial)).toBeCloseTo(1.8, 5);
    // A 2 °C rise reads as a 3.6 °F rise, not a 35.6 °F reading.
    expect(applyDisplayTransformDelta(2, imperial)).toBeCloseTo(3.6, 5);
  });

  it("inverse round-trips every registered branch (entry ⇄ display)", () => {
    for (const type of TRANSFORMED_TYPES) {
      for (const pref of ["metric", "imperial"] as const) {
        const transform = getDisplayTransform(type, pref);
        for (const raw of [0, 1, 36.6, 84, 95.25, 210]) {
          const shown = applyDisplayTransform(raw, transform);
          expect(invertDisplayTransform(shown, transform)).toBeCloseTo(raw, 6);
        }
      }
    }
  });

  it("hasDisplayTransform + TRANSFORMED_TYPES agree, and exclude BMI/glucose", () => {
    expect(hasDisplayTransform("WEIGHT")).toBe(true);
    expect(hasDisplayTransform("BODY_TEMPERATURE")).toBe(true);
    expect(hasDisplayTransform("PULSE")).toBe(false);
    // Deliberately excluded (own preference / universal unit).
    expect(TRANSFORMED_TYPES.has("BLOOD_GLUCOSE")).toBe(false);
    expect(TRANSFORMED_TYPES.has("BODY_MASS_INDEX")).toBe(false);
    // Every registered type resolves a non-identity or symbol-only metric
    // branch, and both branches exist.
    for (const type of TRANSFORMED_TYPES) {
      expect(getDisplayTransform(type, "metric").displayUnit).toBeTruthy();
      expect(getDisplayTransform(type, "imperial").displayUnit).toBeTruthy();
    }
  });
});
