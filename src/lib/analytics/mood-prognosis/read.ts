/**
 * What the surfaces read: the two values of a day, side by side, never merged.
 *
 * The self-assessment is the leading value and is returned exactly as it was
 * stored. The prognosis is the second reading — computed, banded, counted, and
 * not editable. The deviation between them is the finding, and it is measured
 * against the BAND rather than against the midpoint: a rating inside the band
 * is a day that went as the person's own past days suggest, and only a rating
 * outside it is worth a sentence.
 *
 * One reader for every surface. The route, the Coach snapshot and the daily
 * briefing all come through here, so a change to what "the day's forecast"
 * means moves all three together instead of two of them.
 *
 * Absence is explicit and carries its reason and its count. `no-output-yet`
 * and `learning-phase` come from the ladder; `no-pattern` is the honest answer
 * when there are plenty of days and nothing in them the fit could hold on to.
 * None of the three is an error and none of them is a zero.
 */
import { prisma } from "@/lib/db";
import {
  dayKeyAgeInDays,
  isCurrentForTodayClaim,
} from "@/lib/insights/measurement-freshness";
import { DEFAULT_TIMEZONE, moodDateKey } from "@/lib/mood/date-key";

import type { FeatureContribution } from "./forecast";
import { countQualifyingDays } from "./load";
import {
  forecastGate,
  seasonalComparisonsUnlocked,
  type PrognosisStage,
} from "./thresholds";

/** How the day's own rating sat against the band. */
export type PrognosisDeviation = "within" | "above" | "below";

export interface PrognosisPresent {
  present: true;
  /** The day the forecast is about, `YYYY-MM-DD`. */
  date: string;
  /** The expected pleasantness, 0-10. Never shown without `n` and the band. */
  predicted: number;
  ciLow: number | null;
  ciHigh: number | null;
  /** Complete days the fit used. Displayed wherever `predicted` is. */
  n: number;
  modelVersion: string;
  computedAt: string;
  /**
   * Whole days between the forecast's day and the reader's today. A forecast
   * about the day before yesterday cannot back a sentence about today, and
   * `current` is the same rule every other present-tense claim in the product
   * uses — one constant, not a second one.
   */
  ageDays: number | null;
  current: boolean;
  /** Below the regular threshold the forecast is labelled provisional. */
  provisional: boolean;
  stage: PrognosisStage;
  /** Days of history the ladder was read against. */
  entries: number;
  /** Whether weekday and seasonal comparisons have unlocked. */
  seasonalUnlocked: boolean;
  /** The person's own rating for that day. `null` when they gave none. */
  selfAssessment: number | null;
  /** Where that rating sat against the band. `null` without a rating. */
  deviation: PrognosisDeviation | null;
  /** How far outside the band it sat, in scale points. `0` when inside. */
  deviationAmount: number | null;
  /** What the model weighted for that day, largest absolute first. */
  contributions: FeatureContribution[];
}

export interface PrognosisAbsent {
  present: false;
  /**
   * `no-output-yet` — too few days for anything at all.
   * `learning-phase` — enough to describe, not enough to forecast.
   * `no-pattern` — enough days, nothing in them the fit could hold on to.
   */
  reason: "no-output-yet" | "learning-phase" | "no-pattern";
  /** Days of history carrying a self-rating. */
  entries: number;
  /** Days at which the next step unlocks, when a count is what is missing. */
  nextThreshold: number | null;
}

export type PrognosisReading = PrognosisPresent | PrognosisAbsent;

/** Parse the stored contributions. A malformed value reads as none. */
export function parseContributions(stored: string): FeatureContribution[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is FeatureContribution =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as FeatureContribution).feature === "string" &&
        typeof (item as FeatureContribution).contribution === "number",
    );
  } catch {
    return [];
  }
}

/** Where a rating sits against a band. */
export function deviationAgainstBand(
  actual: number,
  low: number | null,
  high: number | null,
): { deviation: PrognosisDeviation; amount: number } | null {
  if (low === null || high === null) return null;
  if (actual > high) return { deviation: "above", amount: actual - high };
  if (actual < low) return { deviation: "below", amount: low - actual };
  return { deviation: "within", amount: 0 };
}

/**
 * The newest forecast an account holds, with the day's own rating beside it.
 *
 * The job writes a trailing window and the newest row in it is normally
 * yesterday's — the pass runs before anybody has logged today. That is why
 * the age travels with the value instead of being assumed to be zero.
 */
export async function readMoodPrognosis(
  userId: string,
  now: Date = new Date(),
  timezone?: string | null,
): Promise<PrognosisReading> {
  const row = await prisma.moodPrediction.findFirst({
    where: { userId },
    orderBy: { date: "desc" },
    select: {
      date: true,
      predicted: true,
      ciLow: true,
      ciHigh: true,
      n: true,
      modelVersion: true,
      features: true,
      computedAt: true,
    },
  });

  if (row === null) {
    // No row is not automatically "too few days": an account can have a year
    // of entries and still get no forecast, because nothing in them cleared
    // the screening. The count decides which of the three answers is true.
    const entries = await countQualifyingDays(userId, now);
    const gate = forecastGate(entries);
    if (!gate.present) {
      return {
        present: false,
        reason: gate.reason,
        entries,
        nextThreshold: gate.nextThreshold,
      };
    }
    return {
      present: false,
      reason: "no-pattern",
      entries,
      nextThreshold: null,
    };
  }

  const [entries, entry] = await Promise.all([
    countQualifyingDays(userId, now),
    prisma.moodEntry.findFirst({
      where: { userId, date: row.date, deletedAt: null, moodA1: { not: null } },
      orderBy: { moodLoggedAt: "desc" },
      select: { moodA1: true },
    }),
  ]);

  const today = moodDateKey(now, timezone ?? DEFAULT_TIMEZONE);
  const ageDays = dayKeyAgeInDays(row.date, today);
  const gate = forecastGate(entries);
  const selfAssessment = entry?.moodA1 ?? null;
  const against =
    selfAssessment === null
      ? null
      : deviationAgainstBand(selfAssessment, row.ciLow, row.ciHigh);

  return {
    present: true,
    date: row.date,
    predicted: row.predicted,
    ciLow: row.ciLow,
    ciHigh: row.ciHigh,
    n: row.n,
    modelVersion: row.modelVersion,
    computedAt: row.computedAt.toISOString(),
    ageDays,
    current: isCurrentForTodayClaim(ageDays),
    provisional: gate.present ? gate.provisional : true,
    stage: gate.stage,
    entries,
    seasonalUnlocked: seasonalComparisonsUnlocked(entries),
    selfAssessment,
    deviation: against?.deviation ?? null,
    deviationAmount: against?.amount ?? null,
    contributions: parseContributions(row.features),
  };
}
