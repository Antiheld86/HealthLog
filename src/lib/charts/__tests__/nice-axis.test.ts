import { describe, expect, it } from "vitest";

import { niceAxis } from "../nice-axis";

/** Every gap between neighbouring ticks, rounded against float noise. */
function steps(ticks: number[]): number[] {
  return ticks.slice(1).map((t, i) => Number((t - ticks[i]).toFixed(6)));
}

describe("niceAxis", () => {
  it("steps a blood pressure pair evenly on round numbers", () => {
    const axis = niceAxis([78, 84, 88, 121, 128, 134]);
    expect(axis).toEqual({ domain: [60, 140], ticks: [60, 80, 100, 120, 140] });
  });

  it("keeps every step equal and the domain on the outer ticks", () => {
    for (const values of [
      [75, 90, 105, 135],
      [61.2, 63.8, 70.1],
      [0.4, 0.9, 1.7],
      [3120, 8840, 12005],
      [-3, 4],
    ]) {
      const axis = niceAxis(values)!;
      expect(new Set(steps(axis.ticks)).size).toBe(1);
      expect(axis.domain).toEqual([axis.ticks[0], axis.ticks.at(-1)]);
      expect(axis.ticks[0]).toBeLessThanOrEqual(Math.min(...values));
      expect(axis.ticks.at(-1)).toBeGreaterThanOrEqual(Math.max(...values));
      expect(axis.ticks.length).toBeLessThanOrEqual(5);
    }
  });

  it("uses 1, 2, 2.5 or 5 times a power of ten as the step", () => {
    for (const values of [
      [75, 135],
      [61, 64],
      [0.1, 0.35],
      [100, 9000],
    ]) {
      const step = steps(niceAxis(values)!.ticks)[0];
      const fraction = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 2.5, 5]).toContain(Number(fraction.toFixed(6)));
    }
  });

  it("starts bars at zero", () => {
    expect(niceAxis([3200, 8100, 11050], { zero: true })).toEqual({
      domain: [0, 15000],
      ticks: [0, 5000, 10000, 15000],
    });
  });

  it("prints decimal ticks without float noise", () => {
    expect(niceAxis([0.1, 0.7])!.ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  });

  it("gives a single level room around it", () => {
    const axis = niceAxis([72, 72])!;
    expect(axis.ticks[0]).toBeLessThan(72);
    expect(axis.ticks.at(-1)).toBeGreaterThan(72);
    expect(new Set(steps(axis.ticks)).size).toBe(1);
  });

  it("ignores gaps and answers null without a value", () => {
    expect(niceAxis([null, undefined, Number.NaN])).toBeNull();
    expect(niceAxis([null, 10, 20])!.ticks).toContain(20);
  });
});
