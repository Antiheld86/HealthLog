/**
 * An evenly stepped value axis: a domain that starts and ends on a tick,
 * and ticks one "nice" step apart (1, 2, 2.5 or 5 times a power of ten).
 *
 * Handing recharts a domain of `["auto", "auto"]` and letting it place the
 * ticks can leave uneven labels once it thins the ones that would collide
 * (75, 90, 105, 135 for a blood pressure line). Explicit ticks on an explicit
 * domain keep every step the same.
 *
 * Pure: no recharts, no React.
 */

export interface NiceAxis {
  domain: [number, number];
  ticks: number[];
}

/** The nice step for a raw step: 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceStep(raw: number): number {
  const exponent = Math.floor(Math.log10(raw));
  const magnitude = 10 ** exponent;
  const fraction = raw / magnitude;
  const nice =
    fraction <= 1
      ? 1
      : fraction <= 2
        ? 2
        : fraction <= 2.5
          ? 2.5
          : fraction <= 5
            ? 5
            : 10;
  return nice * magnitude;
}

/** Decimal places a step needs, so `0.1 * 3` prints as 0.3. */
function decimalsOf(step: number): number {
  if (Number.isInteger(step)) return 0;
  const text = step.toString();
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * The axis for `values`, with at most `maxTicks` ticks. `zero` pins the
 * lower end at 0 for non-negative data (bars start at the baseline). Null
 * when there is no finite value to scale.
 */
export function niceAxis(
  values: ReadonlyArray<number | null | undefined>,
  options: { maxTicks?: number; zero?: boolean } = {},
): NiceAxis | null {
  const finite = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (finite.length === 0) return null;
  const maxTicks = Math.max(2, options.maxTicks ?? 5);
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (options.zero && min >= 0) min = 0;
  if (min === max) {
    // One level: give it room on both sides (or above the baseline).
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    max += pad;
    if (!(options.zero && min === 0)) min -= pad;
  }

  let step = niceStep((max - min) / (maxTicks - 1));
  let lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  // Rounding both ends out can cost a tick; widen the step until it fits.
  while (Math.round((hi - lo) / step) + 1 > maxTicks) {
    step = niceStep(step * 1.01);
    lo = Math.floor(min / step) * step;
    hi = Math.ceil(max / step) * step;
  }

  const decimals = decimalsOf(step);
  const count = Math.round((hi - lo) / step) + 1;
  const ticks = Array.from({ length: count }, (_, i) =>
    Number((lo + i * step).toFixed(decimals)),
  );
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks };
}
