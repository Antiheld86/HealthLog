/**
 * Data mapping for the per-workout heart-rate curve.
 *
 * Pure and separate from the chart component so the shape the axis reads
 * can be asserted without mounting recharts — the y-axis domain is
 * computed from these values, and getting them wrong flattens the curve
 * rather than erroring.
 */

export interface WorkoutHrCurvePoint {
  /** Elapsed seconds from the workout start (bucket left edge). */
  tSec: number;
  mean: number;
  min: number;
  max: number;
}

export interface WorkoutHrChartDatum {
  tSec: number;
  /** Bucket mean, or null where the recording has a hole. */
  mean: number | null;
  /**
   * The min→max ribbon as an explicit `[low, high]` pair — recharts reads
   * an array `dataKey` as a range area and takes its baseline from the
   * first element.
   *
   * This deliberately is NOT a stacked pair of `min` and `max - min`.
   * Stacked series are measured from zero: recharts derives the axis
   * domain for a stack from the stacked offsets, whose baseline is 0
   * (`getDomainOfStackGroups` over `stackOffsetNone`). A chart asking for
   * `dataMin - 10` then resolves to −10 instead of to the bottom of the
   * band, and a session spent between 120 and 170 bpm gets drawn on a
   * −10…180 axis — the shape of the effort, which is the whole point of
   * the curve, squashes into the top quarter. A range area keeps the
   * domain on the bpm values that are actually in the data.
   */
  band: [number, number] | null;
}

/**
 * Lay the bucket points onto a complete elapsed-time grid.
 *
 * A missing bucket becomes an explicit null rather than being skipped, so
 * a hole in the recording breaks the line (`connectNulls` false) instead
 * of being drawn across as if the reading had continued. Absence reads as
 * absence.
 *
 * `envelope` is the server's density verdict: below its threshold the
 * per-bucket min→max spread is noise rather than signal, and the chart
 * draws the mean line alone.
 */
export function buildWorkoutHrChartData(
  points: readonly WorkoutHrCurvePoint[],
  bucketSec: number,
  envelope: boolean,
): WorkoutHrChartDatum[] {
  if (points.length === 0 || bucketSec <= 0) return [];
  const byT = new Map(points.map((p) => [p.tSec, p]));
  const maxT = points[points.length - 1].tSec;
  const grid: WorkoutHrChartDatum[] = [];
  for (let tSec = 0; tSec <= maxT; tSec += bucketSec) {
    const p = byT.get(tSec);
    grid.push({
      tSec,
      mean: p ? p.mean : null,
      band: p && envelope ? [p.min, p.max] : null,
    });
  }
  return grid;
}

/** Breathing room above and below the plotted readings, in bpm. */
const AXIS_PAD_BPM = 10;

/**
 * The bpm range the y-axis has to cover: every plotted reading plus every
 * reference line drawn over them.
 *
 * The markers have to be in the domain or they are not drawn at all —
 * recharts discards an out-of-range `ReferenceLine` rather than clamping
 * it. The session's reported peak is routinely above the curve's own
 * highest point, because the curve plots bucket means and a peak is a
 * single reading, so a domain derived from the data alone drops the peak
 * marker on exactly the sessions that have one. Silently: no warning, no
 * gap, just a line that never appears.
 *
 * Returns null for an empty series, leaving the axis to recharts.
 */
export function workoutHrAxisDomain(
  data: readonly WorkoutHrChartDatum[],
  markers: readonly (number | null | undefined)[] = [],
): [number, number] | null {
  const values: number[] = [];
  for (const datum of data) {
    if (datum.mean != null) values.push(datum.mean);
    if (datum.band) values.push(datum.band[0], datum.band[1]);
  }
  if (values.length === 0) return null;
  for (const marker of markers) {
    if (marker != null && Number.isFinite(marker)) values.push(marker);
  }
  return [
    Math.floor(Math.min(...values) - AXIS_PAD_BPM),
    Math.ceil(Math.max(...values) + AXIS_PAD_BPM),
  ];
}
