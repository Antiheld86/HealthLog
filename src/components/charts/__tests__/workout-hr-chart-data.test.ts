import { describe, it, expect } from "vitest";

import {
  buildWorkoutHrChartData,
  workoutHrAxisDomain,
  type WorkoutHrCurvePoint,
} from "@/components/charts/workout-hr-chart-data";

/**
 * The workout heart-rate curve's data mapping. The assertions that matter
 * are the two that decide whether the rendered curve tells the truth:
 * every value the axis sees has to be a bpm reading (so the domain lands
 * on the band the session was actually in), and a hole in the recording
 * has to stay a hole.
 */

const BUCKET = 10;

/** A dense stretch with a two-bucket hole at 20 s and 30 s. */
const POINTS: WorkoutHrCurvePoint[] = [
  { tSec: 0, mean: 128, min: 122, max: 134 },
  { tSec: 10, mean: 141, min: 133, max: 149 },
  { tSec: 40, mean: 166, min: 158, max: 174 },
];

describe("buildWorkoutHrChartData", () => {
  it("lays the buckets on a complete elapsed grid", () => {
    const data = buildWorkoutHrChartData(POINTS, BUCKET, true);
    expect(data.map((d) => d.tSec)).toEqual([0, 10, 20, 30, 40]);
  });

  it("keeps a hole in the recording as a hole", () => {
    const data = buildWorkoutHrChartData(POINTS, BUCKET, true);
    expect(data[2]).toEqual({ tSec: 20, mean: null, band: null });
    expect(data[3]).toEqual({ tSec: 30, mean: null, band: null });
  });

  it("carries the envelope as the bucket's own [min, max] pair", () => {
    const data = buildWorkoutHrChartData(POINTS, BUCKET, true);
    expect(data[0].band).toEqual([122, 134]);
    expect(data[4].band).toEqual([158, 174]);
  });

  /**
   * The regression this mapping exists to prevent. The band used to ship
   * as a stacked pair — a base at `min` plus a `max - min` delta — and a
   * stack is measured from zero, so the axis domain collapsed to include
   * 0 and the curve was drawn squashed against the top of the plot. Every
   * number handed to the chart must be a bpm reading in the session's own
   * range; a spread posing as a value is what broke it.
   */
  it("hands the axis nothing but bpm readings — no spread, no zero baseline", () => {
    const data = buildWorkoutHrChartData(POINTS, BUCKET, true);
    const lowestReading = Math.min(...POINTS.map((p) => p.min));
    const highestReading = Math.max(...POINTS.map((p) => p.max));

    const values = data.flatMap((d) => [
      ...(d.mean == null ? [] : [d.mean]),
      ...(d.band ?? []),
    ]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(lowestReading);
      expect(value).toBeLessThanOrEqual(highestReading);
    }
  });

  it("drops the band when the server judged the buckets too sparse for one", () => {
    const data = buildWorkoutHrChartData(POINTS, BUCKET, false);
    expect(data.every((d) => d.band === null)).toBe(true);
    expect(data[0].mean).toBe(128);
  });

  it("maps an empty or unusable series to no data at all", () => {
    expect(buildWorkoutHrChartData([], BUCKET, true)).toEqual([]);
    expect(buildWorkoutHrChartData(POINTS, 0, true)).toEqual([]);
  });
});

describe("workoutHrAxisDomain", () => {
  const data = buildWorkoutHrChartData(POINTS, BUCKET, true);

  it("covers the plotted readings with breathing room", () => {
    expect(workoutHrAxisDomain(data)).toEqual([112, 184]);
  });

  /**
   * A reference line outside the axis domain is discarded by recharts,
   * not clamped — so a peak above the curve's own highest bucket mean
   * would simply never be drawn. The reported peak is a single reading
   * and the curve plots bucket means, so that is the common case, not
   * the edge one.
   */
  it("stretches to hold a peak the bucketed curve never reaches", () => {
    const domain = workoutHrAxisDomain(data, [145, 191]);
    expect(domain).not.toBeNull();
    expect(domain![1]).toBeGreaterThanOrEqual(191);
  });

  it("stretches downwards for an average below the curve too", () => {
    const domain = workoutHrAxisDomain(data, [96, null]);
    expect(domain![0]).toBeLessThanOrEqual(96);
  });

  it("ignores markers that are absent or not numbers", () => {
    expect(workoutHrAxisDomain(data, [null, undefined, Number.NaN])).toEqual(
      workoutHrAxisDomain(data),
    );
  });

  it("leaves the axis alone when there is nothing plotted", () => {
    expect(workoutHrAxisDomain([], [140])).toBeNull();
  });
});
