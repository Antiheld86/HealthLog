/**
 * The names the model's inputs are known by, everywhere.
 *
 * One string per feature, stored in `MoodPrediction.features`, read back by
 * the surface that names what the model weighted, and compared against by the
 * tests. It is therefore a wire format in all but name: renaming a key
 * silently orphans every stored row that used it, which is why the encoding is
 * a function here rather than a template literal at four call sites.
 *
 * The shape is `<family>:<rest>`, and the four families are the four places an
 * input can come from:
 *
 *   * `dimension:a2`             — a level-A self-rating (A1 is the target)
 *   * `context:workLoad`         — a numeric field of the day's context
 *   * `context:workStatus=off`   — one value of a closed context vocabulary
 *   * `linked:steps`             — a figure read from the module that owns it
 *
 * Nothing here resolves a label. The label is a locale lookup and this module
 * is pure and bundle-safe, so the resolver lives beside the component that
 * renders it and takes a parsed key from here.
 */
import type { MoodDimensionKey } from "@/lib/mood/dimensions";

/** The linked figures the model may read, and the day-figure each names. */
export const LINKED_FEATURE_METRICS = [
  "sleepAsleep",
  "steps",
  "activeEnergy",
  "restingHeartRate",
  "heartRateVariability",
] as const;

export type LinkedFeatureMetric = (typeof LINKED_FEATURE_METRICS)[number];

export type ParsedFeatureKey =
  | { family: "dimension"; dimension: MoodDimensionKey }
  | { family: "context"; field: string; value: null }
  | { family: "context"; field: string; value: string }
  | { family: "linked"; metric: LinkedFeatureMetric };

/** `dimension:a2` */
export function dimensionFeatureKey(dimension: MoodDimensionKey): string {
  return `dimension:${dimension}`;
}

/** `context:workLoad` — a numeric field. */
export function contextNumericFeatureKey(field: string): string {
  return `context:${field}`;
}

/** `context:workStatus=off` — one value of a closed vocabulary. */
export function contextValueFeatureKey(field: string, value: string): string {
  return `context:${field}=${value}`;
}

/** `linked:steps` */
export function linkedFeatureKey(metric: LinkedFeatureMetric): string {
  return `linked:${metric}`;
}

const DIMENSION_KEYS = new Set(["a1", "a2", "a3", "a4", "a5"]);
const LINKED_KEYS = new Set<string>(LINKED_FEATURE_METRICS);

/**
 * Read a stored key back.
 *
 * `null` for anything this version does not recognise, and that case is real
 * rather than defensive: a row written by an older `modelVersion` can name a
 * feature the current build has dropped, and the surface has to skip it rather
 * than render `undefined` at somebody.
 */
export function parseFeatureKey(key: string): ParsedFeatureKey | null {
  const separator = key.indexOf(":");
  if (separator < 0) return null;
  const family = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  if (rest.length === 0) return null;

  if (family === "dimension") {
    return DIMENSION_KEYS.has(rest)
      ? { family: "dimension", dimension: rest as MoodDimensionKey }
      : null;
  }
  if (family === "linked") {
    return LINKED_KEYS.has(rest)
      ? { family: "linked", metric: rest as LinkedFeatureMetric }
      : null;
  }
  if (family === "context") {
    const equals = rest.indexOf("=");
    if (equals < 0) return { family: "context", field: rest, value: null };
    const field = rest.slice(0, equals);
    const value = rest.slice(equals + 1);
    if (field.length === 0 || value.length === 0) return null;
    return { family: "context", field, value };
  }
  return null;
}
