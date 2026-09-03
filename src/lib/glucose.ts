/**
 * Blood-glucose unit conversions.
 *
 * HealthLog stores glucose canonically in **mg/dL**. The UI can display in
 * mmol/L for users who prefer that (SI-unit countries). Conversion factor is
 * 18.0182 (per DGIM / DDG S3 guideline). We round to clinically meaningful
 * precision: 0 fractional digits for mg/dL, 1 for mmol/L.
 */

export type GlucoseUnit = "mg/dL" | "mmol/L";

/**
 * mg/dL per mmol/L, per the DGIM / DDG S3 guideline. Exported because it is
 * the one factor for this conversion in the tree: the inbound alias resolver
 * normalises a mmol/L cell with it, the glucose insight page scales its chart
 * by its reciprocal, and the helpers below round with it. Two nearly-equal
 * copies of a health conversion is how the same reading comes out as two
 * different numbers on two screens.
 */
export const MGDL_PER_MMOL = 18.0182;

export function mgdlToMmol(mgdl: number): number {
  return Math.round((mgdl / MGDL_PER_MMOL) * 10) / 10;
}

export function mmolToMgdl(mmol: number): number {
  return Math.round(mmol * MGDL_PER_MMOL);
}

export function convertGlucose(value: number, to: GlucoseUnit): number {
  return to === "mmol/L" ? mgdlToMmol(value) : Math.round(value);
}

/**
 * Convert a value the user typed in their display unit back to the
 * canonical mg/dL HealthLog stores. The inverse of {@link convertGlucose}
 * for the editor write path: a `5.5 mmol/L` target the user enters must
 * persist as `99 mg/dL`, not as the literal `5.5`. A `mg/dL` display unit
 * is already canonical, so it only rounds.
 */
export function toCanonicalMgdl(value: number, from: GlucoseUnit): number {
  return from === "mmol/L" ? mmolToMgdl(value) : Math.round(value);
}

export function resolveGlucoseUnit(
  userPreference: string | null | undefined,
): GlucoseUnit {
  return userPreference === "mmol/L" ? "mmol/L" : "mg/dL";
}

/**
 * Threshold metric key corresponding to a glucose context. Keeps the
 * effective-range resolver the single source of truth.
 */
export function thresholdMetricForContext(
  context: "FASTING" | "POSTPRANDIAL" | "RANDOM" | "BEDTIME",
):
  | "BLOOD_GLUCOSE_FASTING"
  | "BLOOD_GLUCOSE_POSTPRANDIAL"
  | "BLOOD_GLUCOSE_RANDOM"
  | "BLOOD_GLUCOSE_BEDTIME" {
  switch (context) {
    case "FASTING":
      return "BLOOD_GLUCOSE_FASTING";
    case "POSTPRANDIAL":
      return "BLOOD_GLUCOSE_POSTPRANDIAL";
    case "RANDOM":
      return "BLOOD_GLUCOSE_RANDOM";
    case "BEDTIME":
      return "BLOOD_GLUCOSE_BEDTIME";
  }
}
