/**
 * The five level-A self-state dimensions of a mood entry.
 *
 * A mood entry has carried one 1–5 value (`MoodEntry.score`) since the first
 * release. That value keeps its meaning and its scale — eleven surfaces read
 * it on the assumption that it runs 1..5 — and the five dimensions below ride
 * beside it as their own 0–10 columns. The two coexist by design: `score` is
 * "how was the day, in one word", the dimensions are "how was the day, in the
 * terms the day was actually made of".
 *
 * Each dimension is stored literally, exactly as the user set it against the
 * anchors they read. A2 (stress) is inverse-oriented — a higher value means a
 * worse day — and it is stored that way rather than flipped at write time. An
 * analytics surface that needs "up is better" flips the sign through
 * `inverse` on this table; nothing flips inline. The same rule already governs
 * rated mood factors (`MoodTag.inverse`), and it exists because a stored value
 * that disagrees with the label the user saw is unrecoverable afterwards.
 *
 * This module is pure: it holds i18n keys and column names, and imports
 * neither Prisma nor the message bundles. The German wording behind every key
 * lives in `messages/de.json` and its five siblings.
 */

/** Wire/DTO key of a level-A dimension. */
export type MoodDimensionKey = "a1" | "a2" | "a3" | "a4" | "a5";

/** `MoodEntry` column a level-A dimension is stored in. */
export type MoodDimensionColumn =
  "moodA1" | "stressA2" | "energyA3" | "connectionA4" | "stabilityA5";

export interface MoodDimension {
  /** Wire key (`a1`…`a5`) accepted by the create schema and echoed on reads. */
  key: MoodDimensionKey;
  /** Prisma field on `MoodEntry` this dimension is stored in. */
  column: MoodDimensionColumn;
  /** i18n key of the dimension's own name. */
  labelKey: string;
  /** i18n key of the wording at the bottom of the scale. */
  lowAnchorKey: string;
  /** i18n key of the wording at the top of the scale. */
  highAnchorKey: string;
  /**
   * A higher stored value means a worse day. Exactly one dimension carries
   * this today (A2, stress), and the unit test pins that count, so a second
   * one cannot be flipped quietly.
   */
  inverse: boolean;
  min: 0;
  max: 10;
}

/**
 * The dimensions in capture order — the order the sliders render in and the
 * order every per-dimension surface iterates. Concept order, not alphabetical:
 * pleasantness first because it is the one the quick check-in already answers.
 */
export const MOOD_DIMENSIONS: readonly MoodDimension[] = [
  {
    key: "a1",
    column: "moodA1",
    labelKey: "mood.dimension.a1.label",
    lowAnchorKey: "mood.dimension.a1.low",
    highAnchorKey: "mood.dimension.a1.high",
    inverse: false,
    min: 0,
    max: 10,
  },
  {
    key: "a2",
    column: "stressA2",
    labelKey: "mood.dimension.a2.label",
    lowAnchorKey: "mood.dimension.a2.low",
    highAnchorKey: "mood.dimension.a2.high",
    inverse: true,
    min: 0,
    max: 10,
  },
  {
    key: "a3",
    column: "energyA3",
    labelKey: "mood.dimension.a3.label",
    lowAnchorKey: "mood.dimension.a3.low",
    highAnchorKey: "mood.dimension.a3.high",
    inverse: false,
    min: 0,
    max: 10,
  },
  {
    key: "a4",
    column: "connectionA4",
    labelKey: "mood.dimension.a4.label",
    lowAnchorKey: "mood.dimension.a4.low",
    highAnchorKey: "mood.dimension.a4.high",
    inverse: false,
    min: 0,
    max: 10,
  },
  {
    key: "a5",
    column: "stabilityA5",
    labelKey: "mood.dimension.a5.label",
    lowAnchorKey: "mood.dimension.a5.low",
    highAnchorKey: "mood.dimension.a5.high",
    inverse: false,
    min: 0,
    max: 10,
  },
] as const;

/** Lowest value any dimension accepts. */
export const MOOD_DIMENSION_MIN = 0;
/** Highest value any dimension accepts. */
export const MOOD_DIMENSION_MAX = 10;

const BY_KEY = new Map<string, MoodDimension>(
  MOOD_DIMENSIONS.map((d) => [d.key, d]),
);

/** The dimension carrying this wire key, or `undefined` for anything else. */
export function getMoodDimension(key: string): MoodDimension | undefined {
  return BY_KEY.get(key);
}

/**
 * Turn a stored value into one where "up" reads as "better".
 *
 * The only legal way to normalise an inverse dimension. Returns `null` for an
 * absent value, because an unanswered dimension is not a neutral one — the
 * whole point of leaving A2..A5 nullable is that absence stays readable as
 * absence.
 */
export function orientForComparison(
  dimension: MoodDimension,
  value: number | null | undefined,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return dimension.inverse ? dimension.max - value : value;
}
