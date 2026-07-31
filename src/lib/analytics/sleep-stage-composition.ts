/**
 * Stage composition for the insights sleep chart — per-night stage minutes
 * over a trailing window, with the day's naps kept OUT of the night.
 *
 * A nap ends on the same wake day as that morning's overnight block, so the
 * per-wake-day totals that back the headline number fold the two together.
 * That is right for "how much did I sleep on this day" and wrong for "what was
 * my night made of": an 80-minute afternoon nap lands as CORE on top of the
 * night and the column reads longer and shallower than the night actually was.
 *
 * So the composition is built from SESSIONS, split by the one nap classifier
 * this codebase has (`pickMainNightAndNaps`, via `separateNightsAndNaps`). The
 * night's stages are the main session's stages. The naps ride along as their
 * own minutes on the same day, never inside the stage buckets.
 *
 * Pure — the caller does the bounded DB read.
 */
import {
  reconstructSleepSessions,
  separateNightsAndNaps,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";

export interface SleepStageCompositionNight {
  /** Wake-day key (YYYY-MM-DD) in the user's timezone. */
  dayKey: string;
  /**
   * Per-stage minutes of the MAIN night only. Keys mirror the Prisma
   * `SleepStage` enum; `IN_BED` is the session envelope, carried as it was
   * before so the chart's own stage order decides what it stacks.
   */
  stages: Record<string, number>;
  /**
   * Total time asleep across this day's naps, in minutes. Absent when the day
   * has no nap — there is no zero to render and nothing to caption.
   */
  napMinutes?: number;
  /** How many naps that is. Absent alongside `napMinutes`. */
  napCount?: number;
}

export interface SleepStageComposition {
  windowDays: number;
  /** Nights carrying at least one stage entry inside the window. */
  nights: number;
  /** Sum of every value in `stages` — nights only, naps excluded. */
  totalMinutes: number;
  /** Window totals per stage, naps excluded. */
  stages: Record<string, number>;
  /** One entry per night with stage data, sorted ascending by day. */
  perNight: SleepStageCompositionNight[];
}

/**
 * Build the trailing-window stage composition from raw per-stage rows.
 *
 * Returns null when no session in the window carries stage data — the
 * analytics consumer renders the plain duration totals without a stage card
 * in that case.
 */
export function buildSleepStageComposition(
  rows: SleepStageRow[],
  tz: string,
  priorityJson: unknown,
  windowDays: number,
): SleepStageComposition | null {
  const sessions = reconstructSleepSessions(rows, tz, priorityJson);
  const days = separateNightsAndNaps(sessions);
  if (days.length === 0) return null;

  const stages: Record<string, number> = {};
  let totalMinutes = 0;
  const perNight: SleepStageCompositionNight[] = [];

  for (const { night, main, naps } of days) {
    const nightStages: Record<string, number> = {};
    for (const [stage, mins] of Object.entries(main.stages)) {
      if (mins == null) continue;
      nightStages[stage] = mins;
      stages[stage] = (stages[stage] ?? 0) + mins;
      totalMinutes += mins;
    }
    if (Object.keys(nightStages).length === 0) continue;
    // The nap total is the very `asleepMinutes` `/api/sleep/night` publishes
    // for the same session, so the two surfaces report one number, not two.
    const napMinutes = naps.reduce((sum, nap) => sum + nap.asleepMinutes, 0);
    perNight.push({
      dayKey: night,
      stages: nightStages,
      ...(napMinutes > 0 ? { napMinutes, napCount: naps.length } : {}),
    });
  }

  if (perNight.length === 0) return null;

  return {
    windowDays,
    nights: perNight.length,
    totalMinutes,
    stages,
    perNight,
  };
}
