/**
 * v1.37 — per-dimension mood series over the level-A columns.
 *
 * A sibling calculator of `mood-aggregates`, following that file's own
 * structure: pure functions over already-fetched rows, no database, no i18n.
 * The hub reads the rows once and hands them here, which is what keeps a
 * second engine from appearing — a parallel `summarize()` of mood that
 * disagreed with the dashboard's is the failure this project has already
 * paid for once.
 *
 * The rule the whole module is built around: a dimension nobody answered is
 * absent, not zero and not a flat line through the middle. On a 0-10
 * self-rating every value in the range is a real answer, so a fabricated one
 * is indistinguishable from a given one — and five is the answer somebody
 * gives on a genuinely average day.
 */
import { MOOD_DIMENSIONS, type MoodDimensionKey } from "@/lib/mood/dimensions";
import { dayKeyAgeInDays } from "@/lib/insights/measurement-freshness";
import { round } from "@/lib/insights/status-shared";

/** Windows the trend reports, in days. Concept §10.1. */
export const MOOD_DIMENSION_WINDOWS = [7, 30, 90] as const;
export type MoodDimensionWindow = (typeof MOOD_DIMENSION_WINDOWS)[number];

/** One day's mean for one dimension. */
export interface MoodDimensionPoint {
  /** `YYYY-MM-DD`, the row's own local day key. */
  date: string;
  value: number;
  samples: number;
}

export interface MoodDimensionSummary {
  key: MoodDimensionKey;
  /** True when at least one entry in the window carries a value. */
  present: boolean;
  /** Higher is worse — the analytics layer flips through this, never inline. */
  inverse: boolean;
  min: number;
  max: number;
  /** Number of entries carrying a value, across the whole window. */
  count: number;
  /** Mean over the trailing 7 / 30 / 90 days; null when that window is empty. */
  avg7: number | null;
  avg30: number | null;
  avg90: number | null;
  /** The most recent value, and how old it is in whole local days. */
  latest: number | null;
  latestDate: string | null;
  newestDaysAgo: number | null;
  /** Daily means, oldest first, over the longest window. */
  series: MoodDimensionPoint[];
}

/** A mood row as this calculator needs it. */
export interface MoodDimensionRow {
  date: string;
  a1: number | null;
  a2: number | null;
  a3: number | null;
  a4: number | null;
  a5: number | null;
}

function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return round(sum / values.length, 1);
}

/**
 * Summarise each of the five dimensions over the rows given.
 *
 * `rows` are the window's entries in any order; `todayKey` is the reader's own
 * local day, already resolved by the caller, so nothing here converts a zone.
 * Each entry contributes at most one value per dimension, and days with
 * several entries are averaged — the same daily-mean shape every other mood
 * surface reports, so a number here can be compared with one there.
 */
export function computeMoodDimensionSeries(
  rows: MoodDimensionRow[],
  todayKey: string,
): MoodDimensionSummary[] {
  const longest = Math.max(...MOOD_DIMENSION_WINDOWS);

  return MOOD_DIMENSIONS.map((dimension) => {
    const byDay = new Map<string, number[]>();
    for (const row of rows) {
      const value = row[dimension.key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const age = dayKeyAgeInDays(row.date, todayKey);
      if (age === null || age < 0 || age >= longest) continue;
      const bucket = byDay.get(row.date);
      if (bucket) bucket.push(value);
      else byDay.set(row.date, [value]);
    }

    const series: MoodDimensionPoint[] = [...byDay.entries()]
      .map(([date, values]) => ({
        date,
        value: meanOf(values) as number,
        samples: values.length,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const count = [...byDay.values()].reduce((acc, v) => acc + v.length, 0);

    const windowMean = (days: number): number | null => {
      const values: number[] = [];
      for (const point of series) {
        const age = dayKeyAgeInDays(point.date, todayKey);
        if (age === null || age >= days) continue;
        values.push(point.value);
      }
      return meanOf(values);
    };

    const newest = series.at(-1) ?? null;

    return {
      key: dimension.key,
      // Presence is decided by whether anybody answered, never by whether the
      // mean happens to be zero.
      present: count > 0,
      inverse: dimension.inverse,
      min: dimension.min,
      max: dimension.max,
      count,
      avg7: windowMean(7),
      avg30: windowMean(30),
      avg90: windowMean(90),
      latest: newest?.value ?? null,
      latestDate: newest?.date ?? null,
      newestDaysAgo: newest ? dayKeyAgeInDays(newest.date, todayKey) : null,
      series,
    };
  });
}
