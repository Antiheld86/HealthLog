/**
 * v1.9.0 — shared metric-aware trend sentiment helpers.
 *
 * Extracted from `trend-card.tsx` so the range-delta caption (the time-range
 * pills feature) paints the exact same colour for the same signal as the
 * dashboard tiles. The mapping is the v1.5 phase-5 audit's: an upward move is
 * good for some metrics (mood, HRV, steps), bad for others (resting HR,
 * weight, body fat), and value-judgement-free for the rest.
 */

/**
 * Maps a metric's "up means" direction to colour sentiment.
 *
 *   - `up-good`   — higher value is better (mood, HRV, steps). ↑ green, ↓ orange.
 *   - `up-bad`    — higher value is worse (resting HR, weight, body fat).
 *                   ↑ orange, ↓ green.
 *   - `neutral`   — direction carries no value judgement (the change renders
 *                   muted).
 *   - `hold`      — the value already sits where the person wants it (weight
 *                   inside their own target band). Staying put is progress
 *                   and renders green; a move either way renders muted, never
 *                   orange, because a small drift inside the band is not a
 *                   setback. See `src/lib/targets/weight-trend.ts`.
 */
export type TrendDirectionSentiment = "up-good" | "up-bad" | "neutral" | "hold";

/**
 * The resolved sentiment of a signed change under a metric's direction.
 *
 *  - `positive` — the change moves the metric toward its goal. Renders green.
 *  - `negative` — the change moves away from the goal. Renders orange.
 *  - `neutral`  — the metric's direction is neutral, or the change is below
 *    the noise floor (|change| < 0.05). Renders muted.
 */
export type TrendSentimentDirection = "positive" | "negative" | "neutral";

export function getTrendSentiment(
  change: number | null | undefined,
  sentiment: TrendDirectionSentiment,
): TrendSentimentDirection {
  if (change == null) return "neutral";
  // Steady inside the target: the one case where "no change" is the news.
  // Uses the same noise floor that draws the flat arrow, so a green arrow is
  // always the flat one.
  if (sentiment === "hold") {
    return Math.abs(change) < 0.05 ? "positive" : "neutral";
  }
  if (Math.abs(change) < 0.05) return "neutral";
  if (sentiment === "neutral") return "neutral";
  const isUp = change > 0;
  const isGood =
    (sentiment === "up-good" && isUp) || (sentiment === "up-bad" && !isUp);
  return isGood ? "positive" : "negative";
}

export function sentimentColorClass(
  direction: TrendSentimentDirection,
): string {
  // Semantic tokens, not raw --dracula-*: `--success` / `--warning` alias
  // the same Dracula green/orange in dark mode (pixel-identical there) but
  // carry the AA-safe `:root.light` overrides, so the trend arrow + delta
  // clear AA on the white card instead of the ~1.2:1 the raw primitives hit.
  if (direction === "positive") return "text-success";
  if (direction === "negative") return "text-warning";
  return "text-muted-foreground";
}
