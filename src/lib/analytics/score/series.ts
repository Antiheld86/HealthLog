/**
 * Reading a run of stored score days as a series, and refusing to draw
 * a line through the place where the recipe changed.
 *
 * Official statistics has one convention for this and it is small: a
 * single machine-readable flag on the FIRST observation after the break
 * (Eurostat's `b`, "break occurring when there is a change in the
 * standards for defining and observing a variable over time"). This
 * module is that flag, plus the two consequences that follow from it.
 *
 * **The composite line breaks.** Two segments, visibly two. A recipe
 * change fails the equal-construct requirement for a legitimate
 * equating by construction: the numbers on either side are averages of
 * different things. The stored day under the old recipe is an overlap
 * point of exactly one, which is enough to date the seam and enough to
 * refuse a comparison across it, and not nearly enough to compute an
 * adjustment factor that would rescale one segment onto the other. So
 * no adjustment is offered. There is no "adjusted" variant of
 * {@link scoreCompositeSegments} and there should not be one: splicing
 * two methods into one continuous line is the failure that produced
 * "years of sleep tracking might be no more useful than common sense",
 * and it always starts as a helpful-looking option.
 *
 * **The per-pillar rows do not break.** A pillar's own 0-100 score is
 * graded against its own published reference band and means the same
 * thing on both sides of the seam. Only the aggregate changes basis.
 * That is why the record stores the per-pillar scores beside the
 * composite rather than folding them away, and it is what lets someone
 * look at their sleep across a period that spans a recipe change
 * without a gap.
 *
 * The seam is drawn on the recipe's VERSION, not on whether the
 * composition visibly moved. A person who deselects a pillar that had
 * no data that week changes what counts even though this week's number
 * did not budge, and the delta guard suppresses that week from less
 * information than this module has. Two surfaces disagreeing about
 * whether the same act was an event is worse than either answer, so
 * both key on the recipe's identity and describe one event.
 *
 * Pure. No database, no clock. The trend view that renders the segments
 * is deliberately not in this release — the records start empty, so
 * there is nothing yet to show — but the flag and the refusal ship with
 * the machinery that creates the seam rather than after it.
 */
import type { ScoreBand, ScorePillarId } from "./types";

/**
 * One stored score day, in the shape `HealthScoreRecord` rows already
 * have, so a Prisma `select` feeds this without a mapping layer in
 * between to get wrong.
 */
export interface ScoreSeriesRecord {
  /** Local calendar day, `YYYY-MM-DD`. */
  dayKey: string;
  composite: number;
  band: ScoreBand;
  composition: string[];
  pillarScores: Record<string, number>;
  /** The recipe version the day was scored under; null on a row written
   * before the writer supplied one. */
  configVersion: number | null;
}

export interface ScoreSeriesPoint extends ScoreSeriesRecord {
  /**
   * Eurostat `b`. True on the first observation computed under a
   * different recipe than the observation before it. Never true on the
   * first observation of the series: a beginning is not a break.
   */
  seamBreak: boolean;
}

/** Ascending by local day. Lexicographic order IS chronological here. */
function byDay(left: ScoreSeriesRecord, right: ScoreSeriesRecord): number {
  return left.dayKey < right.dayKey ? -1 : left.dayKey > right.dayKey ? 1 : 0;
}

/**
 * Whether two consecutive days sit on different bases.
 *
 * An unknown version on either side counts as a break. The seam's job
 * is to refuse a link it cannot justify, and "these two rows were
 * scored under the same recipe" is a claim: a row that does not say
 * which recipe produced it cannot support it. Only rows predating the
 * writer carry null, so in practice this arm is the answer to a
 * question production never asks — which is the point of answering it
 * deliberately rather than letting `null !== 0` decide by accident.
 */
function breaksFrom(
  previous: ScoreSeriesRecord,
  current: ScoreSeriesRecord,
): boolean {
  if (previous.configVersion === null || current.configVersion === null) {
    return true;
  }
  return previous.configVersion !== current.configVersion;
}

/**
 * Mark every stored day with whether it opens a new basis.
 *
 * Input order does not matter; the result is ascending by day.
 */
export function scoreSeriesSeams(
  records: readonly ScoreSeriesRecord[],
): ScoreSeriesPoint[] {
  return [...records].sort(byDay).map((record, index, ordered) => ({
    ...record,
    seamBreak: index > 0 && breaksFrom(ordered[index - 1], record),
  }));
}

/**
 * The composite series, cut into the segments that may honestly be
 * drawn as one line each.
 *
 * Every seam starts a new segment, and nothing here joins two of them:
 * no interpolation across the gap, no offset applied to make the ends
 * meet, no single array with a hole in it that a chart library would
 * happily bridge. A caller that wants one line gets the segments and
 * has to decide, visibly, what to do about the fact that there are two.
 */
export function scoreCompositeSegments(
  points: readonly ScoreSeriesPoint[],
): ScoreSeriesPoint[][] {
  const segments: ScoreSeriesPoint[][] = [];
  for (const point of points) {
    if (segments.length === 0 || point.seamBreak) {
      segments.push([point]);
      continue;
    }
    segments[segments.length - 1].push(point);
  }
  return segments;
}

/**
 * One pillar's own scores across the whole run, seams and all.
 *
 * Continuous on purpose. The pillar is graded against its own published
 * reference band on both sides of a recipe change, so it stays
 * comparable when the average of the pillars does not. Days on which
 * the pillar did not count are absent rather than zero.
 */
export function scorePillarSeries(
  points: readonly ScoreSeriesPoint[],
  pillar: ScorePillarId,
): Array<{ dayKey: string; score: number }> {
  return points.flatMap((point) => {
    const score = point.pillarScores[pillar];
    return typeof score === "number" && Number.isFinite(score)
      ? [{ dayKey: point.dayKey, score }]
      : [];
  });
}
