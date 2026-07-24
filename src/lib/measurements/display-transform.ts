/**
 * v1.7.0 — display-time unit transforms.
 *
 * Canonical storage stays SI (the iOS wire contract + the Withings
 * passthrough both lock raw SI — see the convention block in
 * `apple-health-mapping.ts`). Storage never changes; the metric/imperial
 * user preference (`unitPreference`) only selects which branch a
 * transform exposes at the render boundary.
 *
 * A handful of metrics also read better in a derived unit regardless of
 * preference:
 *
 *   - WALKING_SPEED is stored in m/s but a casual gait of 1.3 m/s
 *     reads as "4.7 km/h" to a human.
 *   - WALKING_RUNNING_DISTANCE is stored in metres but a 5 km walk
 *     reads as "5000 m"; daily totals make more sense in km.
 *
 * The transform is applied at the render layer only (chart `valueScale`
 * + the measurement-list cell + tooltip + entry form). Raw rows,
 * plausibility ranges, rollup math, FHIR/CSV export, the doctor report,
 * and the AI snapshot all keep canonical SI. For a metric user every
 * transform below is the identity on the number (factor 1, offset 0), so
 * the metric render is byte-identical to before — charts stay visually
 * identical. The imperial branch rescales; that is the intended
 * behaviour, not a regression.
 *
 * v1.32.26 — the registry now covers the full weight-class / length /
 * temperature set the display surfaces render, and the interface gained
 * an affine `offset` so °C→°F (a shift, not just a scale) can be
 * expressed. The offset applies to ABSOLUTE values only; deltas, slopes,
 * standard deviations, and band widths take the factor alone — use
 * `applyDisplayTransformDelta` for those.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import { getUnitForType } from "@/lib/validations/measurement";

export type UnitPreference = "metric" | "imperial";

export const DEFAULT_UNIT_PREFERENCE: UnitPreference = "metric";

export interface DisplayTransform {
  /** Multiplier applied to the raw canonical value for display. */
  factor: number;
  /**
   * Additive shift applied AFTER the factor for an absolute display
   * value (`display = raw * factor + offset`). Defaults to 0. Present
   * only for affine conversions (°C→°F). Deltas/slopes/SD must NOT use
   * it — see `applyDisplayTransformDelta`.
   */
  offset?: number;
  /** Unit string shown next to the displayed value. */
  displayUnit: string;
  /** Decimal places for the displayed value. */
  decimals: number;
}

/** Identity transform — raw canonical value, canonical unit. */
const IDENTITY: DisplayTransform = {
  factor: 1,
  displayUnit: "",
  decimals: 1,
};

// kg → lb (exact: 1 lb = 0.45359237 kg → 1 kg = 2.20462262185 lb).
const KG_TO_LB = 2.20462262185;
// cm → in (exact: 1 in = 2.54 cm → 1 cm = 0.393700787402 in).
const CM_TO_IN = 0.393700787402;

/** Shared metric/imperial branch pair for a body-mass metric (kg ↔ lb). */
const MASS_TRANSFORM: Record<UnitPreference, DisplayTransform> = {
  metric: { factor: 1, displayUnit: "kg", decimals: 1 },
  imperial: { factor: KG_TO_LB, displayUnit: "lb", decimals: 1 },
};

/** Shared branch pair for an ABSOLUTE temperature (°C ↔ °F, affine). */
const TEMPERATURE_TRANSFORM: Record<UnitPreference, DisplayTransform> = {
  metric: { factor: 1, displayUnit: "°C", decimals: 1 },
  imperial: { factor: 1.8, offset: 32, displayUnit: "°F", decimals: 1 },
};

/**
 * Per-type, per-preference transforms. Types absent here resolve to the
 * identity transform with the canonical unit from `getUnitForType()`.
 *
 * The metric branch of every entry below is the identity on the number
 * (factor 1, no offset), differing from `getUnitForType` only in the
 * DISPLAY symbol it surfaces (e.g. "°C" for the stored "celsius"). The
 * imperial branch carries the real conversion.
 */
const TRANSFORMS: Partial<
  Record<MeasurementType, Record<UnitPreference, DisplayTransform>>
> = {
  // ── Body-mass metrics (kg canonical → lb imperial) ──
  WEIGHT: MASS_TRANSFORM,
  TOTAL_BODY_WATER: MASS_TRANSFORM,
  BONE_MASS: MASS_TRANSFORM,
  FAT_MASS: MASS_TRANSFORM,
  FAT_FREE_MASS: MASS_TRANSFORM,
  MUSCLE_MASS: MASS_TRANSFORM,
  LEAN_BODY_MASS: MASS_TRANSFORM,
  GRIP_STRENGTH: MASS_TRANSFORM,
  // ── Circumference (cm canonical → in imperial) ──
  WAIST_CIRCUMFERENCE: {
    metric: { factor: 1, displayUnit: "cm", decimals: 1 },
    imperial: { factor: CM_TO_IN, displayUnit: "in", decimals: 1 },
  },
  // ── Absolute temperatures (°C canonical → °F imperial, affine) ──
  BODY_TEMPERATURE: TEMPERATURE_TRANSFORM,
  SKIN_TEMPERATURE: TEMPERATURE_TRANSFORM,
  WRIST_TEMPERATURE: TEMPERATURE_TRANSFORM,
  // A signed baseline DEVIATION (Δ°C) — the °F imperial branch scales by
  // 1.8 but carries NO +32 offset. A one-degree-Celsius deviation is a
  // 1.8-degree-Fahrenheit deviation, not a 33.8 °F reading.
  BODY_TEMPERATURE_DEVIATION: {
    metric: { factor: 1, displayUnit: "°C", decimals: 1 },
    imperial: { factor: 1.8, displayUnit: "°F", decimals: 1 },
  },
  // 1 m/s = 3.6 km/h = 2.236936 mph.
  WALKING_SPEED: {
    metric: { factor: 3.6, displayUnit: "km/h", decimals: 1 },
    imperial: { factor: 2.2369362920544, displayUnit: "mph", decimals: 1 },
  },
  // Daily totals — 1 m = 0.001 km = 0.000621371192 mi.
  WALKING_RUNNING_DISTANCE: {
    metric: { factor: 0.001, displayUnit: "km", decimals: 2 },
    imperial: { factor: 0.000621371192237, displayUnit: "mi", decimals: 2 },
  },
};

/**
 * Every type with a registered transform. The structural guard test uses
 * this set to assert no display surface hardcodes a unit string / scale
 * for a type that should route through the transform instead.
 */
export const TRANSFORMED_TYPES: ReadonlySet<string> = new Set(
  Object.keys(TRANSFORMS),
);

/** True when `type` has a per-preference transform (vs the identity path). */
export function hasDisplayTransform(type: string): boolean {
  return TRANSFORMED_TYPES.has(type);
}

/**
 * Resolve the display transform for a `(type, preference)` pair.
 * Returns the identity transform (with the canonical unit) for every
 * type that has no registered transform, so call sites can apply the
 * result unconditionally.
 */
export function getDisplayTransform(
  type: string,
  preference: UnitPreference = DEFAULT_UNIT_PREFERENCE,
): DisplayTransform {
  const perType = TRANSFORMS[type as MeasurementType];
  if (!perType) {
    return { ...IDENTITY, displayUnit: getUnitForType(type) };
  }
  return perType[preference] ?? perType.metric;
}

/**
 * v1.16.4 — count metrics are integers by definition; any fractional
 * part on a stored sample is source noise (HK chunk splitting, device
 * estimation), so the raw-value surfaces render them with 0 decimals
 * ("9.689 steps", never "9.688,595 steps"). Every other type keeps the
 * formatter's default precision (≤3 digits, trailing zeros dropped).
 */
const INTEGER_DISPLAY_TYPES: ReadonlySet<string> = new Set([
  "ACTIVITY_STEPS",
  "FLIGHTS_CLIMBED",
  "FALL_COUNT",
  // kcal + daylight minutes — whole units are the meaningful display
  // grain for these day-cumulative counts.
  "ACTIVE_ENERGY_BURNED",
  "TIME_IN_DAYLIGHT",
]);

/**
 * Display fraction digits for a RAW (untransformed) value of `type`.
 * `0` for integer count metrics, `undefined` (= formatter default)
 * otherwise — pass the result straight into `Formatters.number`.
 */
export function rawDisplayFractionDigits(type: string): number | undefined {
  return INTEGER_DISPLAY_TYPES.has(type) ? 0 : undefined;
}

/**
 * Apply a transform to a raw canonical ABSOLUTE value:
 * `display = raw * factor + offset`. Pure helper — keeps the arithmetic
 * in one place so the chart, list cell, tooltip, and entry form all
 * scale identically.
 */
export function applyDisplayTransform(
  rawValue: number,
  transform: DisplayTransform,
): number {
  return rawValue * transform.factor + (transform.offset ?? 0);
}

/**
 * Apply a transform to a DELTA / slope / standard-deviation / band-width
 * — factor only, NEVER the offset. A 1 °C change is a 1.8 °F change; it
 * must not pick up the +32 absolute-scale shift.
 */
export function applyDisplayTransformDelta(
  deltaValue: number,
  transform: DisplayTransform,
): number {
  return deltaValue * transform.factor;
}

/**
 * Invert an absolute display value back to the canonical stored value:
 * `raw = (display - offset) / factor`. Used at the entry boundary so an
 * imperial user's typed number persists in canonical SI.
 */
export function invertDisplayTransform(
  displayValue: number,
  transform: DisplayTransform,
): number {
  return (displayValue - (transform.offset ?? 0)) / transform.factor;
}
