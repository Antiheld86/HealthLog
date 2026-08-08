/**
 * What a mood entry's day looked like in the modules that already own it.
 *
 * The rule this file exists to serve is the one the whole context feature
 * hangs off: one fact, one home. Sleep belongs to the sleep module, steps and
 * active energy to the activity data, resting heart rate and HRV to the
 * measurement engine, body symptoms to the illness module. A mood entry shows
 * them and never asks for them a second time, and **nothing here is copied
 * onto the mood row** — every figure is resolved at read time from the rows
 * that own it, so correcting a sleep session corrects it here too, in the same
 * moment, with nothing to re-sync.
 *
 * Two consequences that are easy to get wrong and are therefore stated:
 *
 *   * **Absence is `{ present: false }`, never `0`.** A night nobody recorded
 *     and a night of no sleep are different facts, and a surface that renders
 *     the first as the second is lying about somebody's health record.
 *   * **A module that is switched off blanks its block.** It does not answer
 *     zero and it does not answer a filtered-down version of itself — the
 *     block is simply not there, the same way `snapshot.ts` blanks rather than
 *     filters. Turning a module off is a statement about what the person wants
 *     to see, not a filter over what they wanted to see.
 *
 * The reads are bounded: one local day per entry, resolved through the day-key
 * helper that already carries the legacy-Berlin fallback for `tz IS NULL`
 * rows. There is no unbounded `findMany` here, and adding one would turn a
 * detail view into a table scan on an account with years of history.
 */
import type { MeasurementType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/gate";
import { DEFAULT_TIMEZONE, moodDateKey } from "@/lib/mood/date-key";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";

/** A figure that either exists or honestly does not. */
export type LinkedFigure =
  { present: false } | { present: true; value: number; unit: string };

/** A block that can also be absent because its module is switched off. */
export type LinkedBlock<T> =
  { available: false; reason: "module-disabled" } | ({ available: true } & T);

export interface LinkedSleep {
  /** Time asleep for the night the entry's local day woke up on. */
  asleep: LinkedFigure;
  /** Time in bed, when any writer recorded a bed window. */
  inBed: LinkedFigure;
}

export interface LinkedActivity {
  steps: LinkedFigure;
  activeEnergy: LinkedFigure;
}

export interface LinkedVitals {
  restingHeartRate: LinkedFigure;
  heartRateVariability: LinkedFigure;
}

export interface LinkedBody {
  /** Whether an illness day-log exists for this day at all. */
  logged: boolean;
  /** How much the day was limited, 0-3, as the illness module records it. */
  functionalImpact: LinkedFigure;
  /** Symptoms linked to that day-log, by their catalogue key. */
  symptoms: string[];
  /** The episode to open in the illness module, when there is one. */
  episodeId: string | null;
}

export interface LinkedDayContext {
  /** The entry's local day, resolved through the entry's own `tz`. */
  day: string;
  sleep: LinkedBlock<LinkedSleep>;
  activity: LinkedBlock<LinkedActivity>;
  /**
   * Resting heart rate and HRV. Not gated: the measurement engine is core and
   * has no off switch, so this block is always available and answers absence
   * per figure instead.
   */
  vitals: LinkedBlock<LinkedVitals>;
  body: LinkedBlock<LinkedBody>;
}

const MODULE_OFF = { available: false, reason: "module-disabled" } as const;
const ABSENT: LinkedFigure = { present: false };

function figure(value: number | null | undefined, unit: string): LinkedFigure {
  // A stored zero is a real reading and stays one. Only a missing row is
  // absent, which is why this tests for null rather than for falsiness.
  return value === null || value === undefined
    ? ABSENT
    : { present: true, value, unit };
}

/** Sum a day's rows for a cumulative metric; no rows means absent, not zero. */
function sumOfDay(
  rows: ReadonlyArray<{ type: MeasurementType; value: number }>,
  type: MeasurementType,
  unit: string,
): LinkedFigure {
  const matching = rows.filter((r) => r.type === type);
  if (matching.length === 0) return ABSENT;
  return {
    present: true,
    value: matching.reduce((sum, r) => sum + r.value, 0),
    unit,
  };
}

/** Latest reading of the day for a point-in-time metric. */
function latestOfDay(
  rows: ReadonlyArray<{
    type: MeasurementType;
    value: number;
    measuredAt: Date;
  }>,
  type: MeasurementType,
  unit: string,
): LinkedFigure {
  const matching = rows
    .filter((r) => r.type === type)
    .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
  if (matching.length === 0) return ABSENT;
  return { present: true, value: matching[matching.length - 1].value, unit };
}

/**
 * A UTC window guaranteed to contain one local day, whatever its zone.
 *
 * Generous on both sides on purpose: the exact boundaries are decided by
 * `moodDateKey` afterwards, and this only has to be sure it did not clip the
 * day off at either end. Doing the arithmetic here instead would mean
 * re-deriving a zone offset that the day-key helper already knows, and that
 * second derivation is where the DST hour goes missing.
 */
function localDayWindow(day: string): { from: Date; to: Date } {
  // Walk outwards from the naive UTC midnight and keep whatever the day-key
  // helper agrees belongs to this day. Cheaper and far safer than arithmetic
  // on `new Date(y, m, d)`, which slips by an hour twice a year and has
  // already been solved once in this codebase.
  const naive = new Date(`${day}T00:00:00.000Z`);
  const from = new Date(naive.getTime() - 26 * 60 * 60 * 1000);
  const to = new Date(naive.getTime() + 50 * 60 * 60 * 1000);
  return { from, to };
}

/** Keep only the rows whose own local day is the one asked for. */
function onDay<T extends { measuredAt: Date }>(
  rows: readonly T[],
  day: string,
  tz: string,
): T[] {
  return rows.filter((r) => moodDateKey(r.measuredAt, tz) === day);
}

/** The measurement types the linked block reads. One query covers all four. */
const LINKED_MEASUREMENT_TYPES: MeasurementType[] = [
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "ACTIVE_ENERGY_BURNED",
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
];

/**
 * Resolve the linked figures for one entry's local day.
 *
 * Takes the entry's own `date` and `tz` rather than re-deriving them, because
 * the row already decided which day it belongs to and a second derivation here
 * could disagree with it — which is precisely the class of bug the per-row
 * `tz` column was added to end.
 */
export async function resolveLinkedDayContext(
  userId: string,
  entry: { date: string; tz: string | null },
): Promise<LinkedDayContext> {
  const tz = entry.tz ?? DEFAULT_TIMEZONE;
  const day = entry.date;
  const { from, to } = localDayWindow(day);

  const [sleepOn, activityOn, illnessOn] = await Promise.all([
    isModuleEnabled(userId, "sleep"),
    isModuleEnabled(userId, "workouts"),
    isModuleEnabled(userId, "illness"),
  ]);

  const measurements = await prisma.measurement.findMany({
    where: {
      userId,
      deletedAt: null,
      type: { in: LINKED_MEASUREMENT_TYPES },
      measuredAt: { gte: from, lte: to },
    },
    select: {
      type: true,
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
    orderBy: { measuredAt: "asc" },
  });

  const dayRows = onDay(measurements, day, tz);

  let sleep: LinkedBlock<LinkedSleep> = MODULE_OFF;
  if (sleepOn) {
    // The stage rows of the whole window, not just the day's, and then the
    // night whose WAKE day is this one. A night starts the evening before, so
    // filtering the raw rows by day first would cut it in half — the
    // reconstruction is the thing that knows where a night begins.
    const stageRows = measurements.filter((r) => r.type === "SLEEP_DURATION");
    if (stageRows.length === 0) {
      sleep = { available: true, asleep: ABSENT, inBed: ABSENT };
    } else {
      const priority = await loadUserSourcePriority(userId);
      const night = reconstructSleepNights(
        stageRows as unknown as SleepStageRow[],
        tz,
        priority,
      ).find((n) => n.night === day);
      sleep = {
        available: true,
        asleep: figure(night?.asleepMinutes ?? null, "min"),
        inBed: figure(night?.inBedMinutes ?? null, "min"),
      };
    }
  }

  const activity: LinkedBlock<LinkedActivity> = activityOn
    ? {
        available: true,
        steps: sumOfDay(dayRows, "ACTIVITY_STEPS", "steps"),
        activeEnergy: sumOfDay(dayRows, "ACTIVE_ENERGY_BURNED", "kcal"),
      }
    : MODULE_OFF;

  const vitals: LinkedBlock<LinkedVitals> = {
    available: true,
    restingHeartRate: latestOfDay(dayRows, "RESTING_HEART_RATE", "bpm"),
    heartRateVariability: latestOfDay(dayRows, "HEART_RATE_VARIABILITY", "ms"),
  };

  let body: LinkedBlock<LinkedBody> = MODULE_OFF;
  if (illnessOn) {
    // Read only. The illness module owns symptom capture and its severity
    // scale; the mood surface links into it and captures nothing, which is
    // what keeps the two from disagreeing about the same day.
    const dayLog = await prisma.illnessDayLog.findFirst({
      where: { userId, date: day, deletedAt: null },
      select: {
        episodeId: true,
        functionalImpact: true,
        symptomLinks: {
          select: { severity: true, symptom: { select: { key: true } } },
        },
      },
    });
    body = {
      available: true,
      logged: dayLog !== null,
      functionalImpact: figure(dayLog?.functionalImpact ?? null, "level"),
      symptoms: dayLog?.symptomLinks.map((l) => l.symptom.key) ?? [],
      episodeId: dayLog?.episodeId ?? null,
    };
  }

  return { day, sleep, activity, vitals, body };
}
