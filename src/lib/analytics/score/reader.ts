import type {
  GlucoseContext,
  MeasurementSource,
  MeasurementType,
  PrismaClient,
  SleepStage,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { BpInTargetEnvelope } from "@/lib/analytics/bp-in-target-fast-path";
import { collectBpPairs } from "@/lib/analytics/bp-in-target";
import {
  gradeBpScoreFromSeries,
  representativeBpFromSeries,
} from "@/lib/analytics/bp-grade";
import type { BpTargets } from "@/lib/analytics/bp-targets";
import { resolveWeightTargetOverride } from "@/lib/analytics/effective-range";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { reconstructNights } from "@/lib/insights/derived/sleep-score";
import { pickCumulativeDaySum } from "@/lib/measurements/cumulative-day-sum";
import { userDayKey } from "@/lib/tz/format";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import { toProfileSex } from "@/lib/profile/sex";
import { healthScoreAlgorithmItemKey } from "@/lib/daily/priority-item-key";
import { annotate } from "@/lib/logging/context";

import { ACTIVITY_WINDOW_DAYS } from "./activity";
import { SLEEP_WINDOW_DAYS } from "./sleep";
import { attachScoreDelta } from "./composite";
import { computeHealthScore } from "./index";
import type { HealthScoreReport, PillarInputs, ScorePillarId } from "./types";
import { computeWeightGoal } from "./weight-goal";
import { DAY_MS, uniqueSources } from "./shared";
import type { DerivedProvenanceSource } from "@/lib/insights/derived/types";

const HISTORY_OFFSET_DAYS = 14;
const SCORE_READ_DAYS = 365 + HISTORY_OFFSET_DAYS;

export interface ScoreReaderProfile {
  dateOfBirth: Date | null;
  gender: string | null;
  heightCm: number | null;
  timezone: string;
  sourcePriorityJson: unknown;
  thresholdsJson: unknown;
}

export interface ScoreReaderModules {
  glucose: boolean;
  labs: boolean;
  sleep: boolean;
  mentalHealth: boolean;
}

export interface UserHealthScoreInput {
  prisma?: PrismaClient;
  userId: string;
  now: Date;
  profile: ScoreReaderProfile;
  modules: ScoreReaderModules;
  bpTargets: BpTargets | null;
  bpEnvelope: BpInTargetEnvelope | null;
  bpEnvelopePriorWeek: BpInTargetEnvelope | null;
  bpEnvelopePriorTwoWeeks: BpInTargetEnvelope | null;
}

type MeasurementRow = {
  type: MeasurementType;
  value: number;
  unit: string;
  source: MeasurementSource;
  measuredAt: Date;
  deviceType: string | null;
  glucoseContext?: GlucoseContext | null;
  sleepStage?: SleepStage | null;
};

type Settled<T> = { ok: true; value: T } | { ok: false; value: T };

interface ActivityRead {
  days: Array<{ day: string; value: number }>;
  sources: string[];
  sourceDays: Array<{ day: string; source: string }>;
  path: "rollup" | "live";
}

interface ScoreBpEnvelope {
  path: "rollup" | "live" | undefined;
  last90Days: { pairs: number } | null;
  gradedScore: number | null;
  representative: { sys: number; dia: number } | null;
  last90EarliestAt: Date | null;
  last90LatestAt: Date | null;
  readFailed: boolean;
  target: BpTargets | null;
}

async function capture<T>(
  promise: Promise<T>,
  fallback: T,
  failure?:
    ScorePillarId | "WEIGHT_GOAL" | "ALGORITHM_NOTICE" | ScorePillarId[],
): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch {
    const failures = Array.isArray(failure)
      ? failure
      : failure
        ? [failure]
        : [];
    if (failures.length > 0) {
      annotate({
        meta: {
          analytics: {
            health_score: Object.fromEntries(
              failures.map((failed) => [failed, "read_failed"]),
            ),
          },
        },
      });
    }
    return { ok: false, value: fallback };
  }
}

async function readMeasurements(
  db: PrismaClient,
  userId: string,
  types: MeasurementType[],
  since: Date,
  glucoseContext?: GlucoseContext,
): Promise<MeasurementRow[]> {
  return db.measurement.findMany({
    where: {
      userId,
      type: { in: types },
      measuredAt: { gte: since },
      deletedAt: null,
      ...(glucoseContext ? { glucoseContext } : {}),
    },
    orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
    select: {
      type: true,
      value: true,
      unit: true,
      source: true,
      measuredAt: true,
      deviceType: true,
      glucoseContext: true,
      sleepStage: true,
    },
  });
}
export function readFastingGlucoseMeasurements(
  db: PrismaClient,
  userId: string,
  now: Date,
): Promise<MeasurementRow[]> {
  return readMeasurements(
    db,
    userId,
    ["BLOOD_GLUCOSE"],
    new Date(now.getTime() - (90 + HISTORY_OFFSET_DAYS) * DAY_MS),
    "FASTING",
  );
}

export async function readActivityDays(args: {
  db: PrismaClient;
  userId: string;
  since: Date;
  priority: unknown;
  timezone: string;
  asOf: Date;
}): Promise<ActivityRead> {
  // DAY rollups are UTC buckets and have already summed all devices for a
  // source. Neither the user's local-day boundary nor Watch/phone
  // canonicalisation can be recovered from that aggregate, so score parity
  // requires the raw canonical path for every timezone.
  const rows = await readMeasurements(
    args.db,
    args.userId,
    ["ACTIVITY_STEPS"],
    args.since,
  );
  const canonical = pickCanonicalSourceRows(
    rows,
    "steps",
    args.priority,
    (date) => userDayKey(date, args.timezone),
  ).canonicalRows;
  return {
    days: pickCumulativeDaySum(canonical, (date) =>
      userDayKey(date, args.timezone),
    ).map((point) => ({
      day: userDayKey(point.date, args.timezone),
      value: point.value,
    })),
    sources: uniqueSources(
      canonical
        .filter((row) => {
          const day = userDayKey(row.measuredAt, args.timezone);
          const endDay = userDayKey(args.asOf, args.timezone);
          const startDay = userDayKey(
            new Date(args.asOf.getTime() - (ACTIVITY_WINDOW_DAYS - 1) * DAY_MS),
            args.timezone,
          );
          return day >= startDay && day <= endDay;
        })
        .map((row) => row.source),
    ),
    sourceDays: canonical.map((row) => ({
      day: userDayKey(row.measuredAt, args.timezone),
      source: row.source,
    })),
    path: "live",
  };
}

function normaliseAnalyte(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

const HBA1C_NAMES: Record<string, true> = {
  hba1c: true,
  hemoglobina1c: true,
  haemoglobina1c: true,
  glycatedhemoglobin: true,
  glycatedhaemoglobin: true,
};

const LIPID_NAMES: Record<string, true> = {
  ldl: true,
  ldlcholesterol: true,
  ldlc: true,
  hdl: true,
  hdlcholesterol: true,
  hdlc: true,
  triglycerides: true,
  triglyceride: true,
  totalcholesterol: true,
  cholesteroltotal: true,
  apob: true,
  apolipoproteinb: true,
};

function pickStableSourceRows<T extends { source: MeasurementSource }>(
  rows: T[],
  key: (row: T) => string,
): T[] {
  return Array.from(Map.groupBy(rows, key).values()).flatMap((group) => {
    const source = [...new Set(group.map((row) => row.source))].sort()[0];
    return group.filter((row) => row.source === source);
  });
}

function personalBpTarget(
  thresholdsJson: unknown,
  clinical: BpTargets | null,
): BpTargets | null {
  if (!clinical || !thresholdsJson || typeof thresholdsJson !== "object") {
    return null;
  }
  const thresholds = thresholdsJson as Record<string, unknown>;
  const readBand = (key: string): { min: number; max: number } | null => {
    const value = thresholds[key];
    if (!value || typeof value !== "object") return null;
    const { min, max } = value as { min?: unknown; max?: unknown };
    return typeof min === "number" &&
      Number.isFinite(min) &&
      typeof max === "number" &&
      Number.isFinite(max) &&
      min < max
      ? { min, max }
      : null;
  };
  const sys = readBand("BLOOD_PRESSURE_SYS");
  const dia = readBand("BLOOD_PRESSURE_DIA");
  if (!sys && !dia) return null;
  return {
    sysLow: sys?.min ?? clinical.sysLow,
    sysHigh: sys?.max ?? clinical.sysHigh,
    diaLow: dia?.min ?? clinical.diaLow,
    diaHigh: dia?.max ?? clinical.diaHigh,
  };
}

function canonicalBpRowsForWindow(
  rows: MeasurementRow[],
  input: UserHealthScoreInput,
  at: Date,
): MeasurementRow[] {
  const since = new Date(at.getTime() - 90 * DAY_MS);
  return pickCanonicalSourceRows(
    rows.filter((row) => row.measuredAt >= since && row.measuredAt <= at),
    "bloodPressure",
    input.profile.sourcePriorityJson,
    (date) => userDayKey(date, input.profile.timezone),
  ).canonicalRows;
}

function scoreBpEnvelope(args: {
  base: BpInTargetEnvelope | null;
  at: Date;
  input: UserHealthScoreInput;
  rows: Settled<MeasurementRow[]>;
}): { envelope: ScoreBpEnvelope; sources: string[] } {
  if (args.base) {
    return {
      envelope: {
        path: args.base.path,
        last90Days: args.base.last90Days,
        gradedScore: args.base.gradedScore,
        representative: args.base.representative,
        last90EarliestAt: args.base.last90EarliestAt,
        last90LatestAt: args.base.last90LatestAt,
        readFailed: false,
        target: args.input.bpTargets,
      },
      sources: args.rows.ok
        ? uniqueSources(
            canonicalBpRowsForWindow(args.rows.value, args.input, args.at).map(
              (row) => row.source,
            ),
          )
        : [args.base.path],
    };
  }

  const target = args.input.bpTargets;
  if (!args.rows.ok) {
    return {
      envelope: {
        path: undefined,
        last90Days: null,
        gradedScore: null,
        representative: null,
        last90EarliestAt: null,
        last90LatestAt: null,
        readFailed: true,
        target,
      },
      sources: [],
    };
  }

  const canonical = canonicalBpRowsForWindow(
    args.rows.value,
    args.input,
    args.at,
  );
  const pairs = collectBpPairs(
    canonical
      .filter((row) => row.type === "BLOOD_PRESSURE_SYS")
      .map((row) => ({ measuredAt: row.measuredAt, value: row.value })),
    canonical
      .filter((row) => row.type === "BLOOD_PRESSURE_DIA")
      .map((row) => ({ measuredAt: row.measuredAt, value: row.value })),
    args.input.profile.timezone,
  ).filter(
    (pair) =>
      pair.at <= args.at &&
      pair.at >= new Date(args.at.getTime() - 90 * DAY_MS),
  );
  return {
    envelope: {
      path: "live",
      last90Days: { pairs: pairs.length },
      gradedScore: target
        ? gradeBpScoreFromSeries({
            pairs,
            target,
            now: args.at,
          })
        : null,
      representative: representativeBpFromSeries({ pairs, now: args.at }),
      last90EarliestAt: pairs[0]?.at ?? null,
      last90LatestAt: pairs.at(-1)?.at ?? null,
      readFailed: false,
      target,
    },
    sources: uniqueSources(canonical.map((row) => row.source)),
  };
}

function scoreInputsFor(args: {
  asOf: Date;
  input: UserHealthScoreInput;
  bp: ScoreBpEnvelope;
  bpSources: string[];
  glucose: Settled<MeasurementRow[]>;
  activity: Settled<ActivityRead>;
  sleep: Settled<MeasurementRow[]>;
  adiposity: Settled<MeasurementRow[]>;
  fitness: Settled<MeasurementRow[]>;
  assessments: Settled<
    Array<{
      instrument: "PHQ9" | "GAD7" | "WHO5" | "SCI";
      totalScore: number;
      item9Flagged: boolean;
      takenAt: Date;
    }>
  >;
  labs: Settled<
    Array<{
      analyte: string;
      value: number | null;
      unit: string;
      referenceLow: number | null;
      referenceHigh: number | null;
      panel: string | null;
      takenAt: Date;
      source: string;
      biomarker: {
        name: string;
        unit: string;
        referenceLow: number | null;
        referenceHigh: number | null;
      } | null;
    }>
  >;
}): PillarInputs {
  const { asOf, input } = args;
  const ageYears = getAgeFromDateOfBirth(input.profile.dateOfBirth);
  const asOfDay = userDayKey(asOf, input.profile.timezone);
  const activitySinceDay = userDayKey(
    new Date(asOf.getTime() - (ACTIVITY_WINDOW_DAYS - 1) * DAY_MS),
    input.profile.timezone,
  );
  const sleepSinceDay = userDayKey(
    new Date(asOf.getTime() - (SLEEP_WINDOW_DAYS - 1) * DAY_MS),
    input.profile.timezone,
  );
  const sex = toProfileSex(input.profile.gender);
  const fastingCanonical = pickStableSourceRows(
    args.glucose.value.filter((row) => row.glucoseContext === "FASTING"),
    (row) => userDayKey(row.measuredAt, input.profile.timezone),
  );
  const sleepNights = reconstructNights(
    args.sleep.value.map((row) => ({
      value: row.value,
      measuredAt: row.measuredAt,
      sleepStage: row.sleepStage ?? null,
      source: row.source,
      deviceType: row.deviceType,
    })),
    input.profile.timezone,
    input.profile.sourcePriorityJson,
  );
  const hba1c = args.labs.value.filter((row) => {
    const name = normaliseAnalyte(row.biomarker?.name ?? row.analyte);
    return row.value != null && HBA1C_NAMES[name] === true;
  });
  const lipids = args.labs.value.filter((row) => {
    const name = normaliseAnalyte(row.biomarker?.name ?? row.analyte);
    return row.value != null && LIPID_NAMES[name] === true;
  });
  const adiposityCanonical = pickStableSourceRows(
    args.adiposity.value,
    (row) =>
      `${row.type}|${userDayKey(row.measuredAt, input.profile.timezone)}`,
  );
  const fitnessCanonical = pickCanonicalSourceRows(
    args.fitness.value,
    "vo2Max",
    input.profile.sourcePriorityJson,
    (date) => userDayKey(date, input.profile.timezone),
  ).canonicalRows;

  return {
    BLOOD_PRESSURE: {
      source: readSource(args.bp.path),
      readFailed: args.bp.readFailed,
      asOf,
      pairCount: args.bp.last90Days?.pairs ?? 0,
      gradedScore: args.bp.gradedScore,
      representative: args.bp.representative,
      oldestAt: args.bp.last90EarliestAt,
      latestAt: args.bp.last90LatestAt,
      target: args.bp.target,
      personalTarget: personalBpTarget(
        input.profile.thresholdsJson,
        args.bp.target,
      ),
      sources: args.bpSources,
    },
    GLYCAEMIA: {
      source: "live",
      readFailed:
        (!input.modules.glucose || !args.glucose.ok) &&
        (!input.modules.labs || !args.labs.ok),
      asOf,
      hba1cReadFailed: input.modules.labs && !args.labs.ok,
      fastingReadFailed: input.modules.glucose && !args.glucose.ok,
      hba1c: input.modules.labs
        ? hba1c.map((row) => ({
            value: row.value!,
            unit: row.biomarker?.unit ?? row.unit,
            at: row.takenAt,
            source: row.source,
          }))
        : [],
      fastingGlucose: input.modules.glucose
        ? fastingCanonical.map((row) => ({
            value: row.value,
            at: row.measuredAt,
            source: row.source,
          }))
        : [],
    },
    ACTIVITY: {
      source: args.activity.ok ? readSource(args.activity.value.path) : "none",
      readFailed: !args.activity.ok,
      timezone: input.profile.timezone,
      asOf,
      ageYears,
      days: args.activity.value.days,
      sources: uniqueSources(
        args.activity.value.sourceDays
          .filter((row) => row.day >= activitySinceDay && row.day <= asOfDay)
          .map((row) => row.source),
      ),
    },
    SLEEP: {
      source: "live",
      readFailed: !args.sleep.ok,
      timezone: input.profile.timezone,
      asOf,
      ageYears,
      nights: sleepNights.map((night) => ({
        night: night.night,
        asleepMinutes: night.asleepMinutes,
        midpoint: night.midpoint,
      })),
      sources: uniqueSources(
        args.sleep.value
          .filter((row) => {
            const day = userDayKey(row.measuredAt, input.profile.timezone);
            return day >= sleepSinceDay && day <= asOfDay;
          })
          .map((row) => row.source),
      ),
    },
    ADIPOSITY: {
      source: "live",
      readFailed: !args.adiposity.ok,
      asOf,
      heightCm: input.profile.heightCm,
      rows: adiposityCanonical.map((row) => ({
        type: row.type as "WAIST_CIRCUMFERENCE" | "WAIST_TO_HEIGHT",
        value: row.value,
        unit: row.unit,
        at: row.measuredAt,
        source: row.source,
      })),
    },
    WELLBEING: {
      source: "live",
      readFailed: !args.assessments.ok,
      asOf,
      assessments: args.assessments.value
        .filter((row) => row.instrument !== "SCI")
        .map((row) => ({
          instrument: row.instrument as "PHQ9" | "GAD7" | "WHO5",
          totalScore: row.totalScore,
          item9Flagged: row.item9Flagged,
          at: row.takenAt,
        })),
    },
    FITNESS: {
      source: "live",
      readFailed: !args.fitness.ok,
      asOf,
      ageYears,
      sex,
      // The schema records VO₂max but does not distinguish CPET measurements
      // from device estimates. No current row can therefore prove `measured`.
      rows: fitnessCanonical.map((row) => ({
        value: row.value,
        at: row.measuredAt,
        source: row.source,
        measured: false,
      })),
    },
    LIPIDS: {
      source: "live",
      readFailed: !args.labs.ok,
      asOf,
      rows: lipids.map((row) => ({
        marker: row.biomarker?.name ?? row.analyte,
        value: row.value!,
        unit: row.unit || row.biomarker?.unit || "",
        referenceLow: row.referenceLow ?? row.biomarker?.referenceLow ?? null,
        referenceHigh:
          row.referenceHigh ?? row.biomarker?.referenceHigh ?? null,
        panel: row.panel,
        at: row.takenAt,
        source: row.source,
      })),
    },
  };
}

function readSource(
  path: "rollup" | "live" | undefined,
): DerivedProvenanceSource {
  if (path === "rollup") return "DAY";
  return path ?? "none";
}

export async function computeUserHealthScore(
  input: UserHealthScoreInput,
): Promise<HealthScoreReport> {
  const db = input.prisma ?? prisma;
  const since = new Date(input.now.getTime() - SCORE_READ_DAYS * DAY_MS);
  const activitySince = new Date(
    input.now.getTime() - (28 + HISTORY_OFFSET_DAYS) * DAY_MS,
  );
  const [
    glucose,
    activity,
    sleep,
    adiposity,
    fitness,
    assessments,
    labs,
    weights,
    bpRows,
  ] = await Promise.all([
    input.modules.glucose
      ? capture(
          readFastingGlucoseMeasurements(db, input.userId, input.now),
          [],
          "GLYCAEMIA",
        )
      : Promise.resolve({ ok: true as const, value: [] }),
    capture(
      readActivityDays({
        db,
        userId: input.userId,
        since: activitySince,
        priority: input.profile.sourcePriorityJson,
        asOf: input.now,
        timezone: input.profile.timezone,
      }),
      { days: [], sources: [], sourceDays: [], path: "live" as const },
      "ACTIVITY",
    ),
    input.modules.sleep
      ? capture(
          readMeasurements(db, input.userId, ["SLEEP_DURATION"], activitySince),
          [],
          "SLEEP",
        )
      : Promise.resolve({ ok: true as const, value: [] }),
    capture(
      readMeasurements(
        db,
        input.userId,
        ["WAIST_CIRCUMFERENCE", "WAIST_TO_HEIGHT"],
        since,
      ),
      [],
      "ADIPOSITY",
    ),
    capture(
      readMeasurements(db, input.userId, ["VO2_MAX"], since),
      [],
      "FITNESS",
    ),
    input.modules.mentalHealth
      ? capture(
          db.mentalHealthAssessment.findMany({
            where: {
              userId: input.userId,
              takenAt: { gte: since },
              deletedAt: null,
            },
            orderBy: { takenAt: "asc" },
            select: {
              instrument: true,
              totalScore: true,
              item9Flagged: true,
              takenAt: true,
            },
          }),
          [],
          "WELLBEING",
        )
      : Promise.resolve({ ok: true as const, value: [] }),
    input.modules.labs
      ? capture(
          db.labResult.findMany({
            where: {
              userId: input.userId,
              takenAt: { gte: since },
              deletedAt: null,
              value: { not: null },
            },
            orderBy: { takenAt: "asc" },
            select: {
              analyte: true,
              value: true,
              unit: true,
              referenceLow: true,
              referenceHigh: true,
              panel: true,
              takenAt: true,
              source: true,
              biomarker: {
                select: {
                  name: true,
                  unit: true,
                  referenceLow: true,
                  referenceHigh: true,
                },
              },
            },
          }),
          [],
          ["GLYCAEMIA", "LIPIDS"],
        )
      : Promise.resolve({ ok: true as const, value: [] }),
    capture(
      readMeasurements(db, input.userId, ["WEIGHT"], since),
      [],
      "WEIGHT_GOAL",
    ),
    capture(
      readMeasurements(
        db,
        input.userId,
        ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
        new Date(input.now.getTime() - 104 * DAY_MS),
      ),
      [],
      "BLOOD_PRESSURE",
    ),
  ]);

  const availablePillars: ScorePillarId[] = [
    "BLOOD_PRESSURE",
    ...(input.modules.glucose || input.modules.labs
      ? ["GLYCAEMIA" as const]
      : []),
    "ACTIVITY",
    ...(input.modules.sleep ? ["SLEEP" as const] : []),
    "ADIPOSITY",
    ...(input.modules.mentalHealth ? ["WELLBEING" as const] : []),
    "FITNESS",
    ...(input.modules.labs ? ["LIPIDS" as const] : []),
  ];
  const previousAt = new Date(input.now.getTime() - 7 * DAY_MS);
  const previousPreviousAt = new Date(input.now.getTime() - 14 * DAY_MS);
  const currentBp = scoreBpEnvelope({
    base: input.bpEnvelope,
    at: input.now,
    input,
    rows: bpRows,
  });
  const previousBp = scoreBpEnvelope({
    base: input.bpEnvelopePriorWeek,
    at: previousAt,
    input,
    rows: bpRows,
  });
  const previousPreviousBp = scoreBpEnvelope({
    base: input.bpEnvelopePriorTwoWeeks,
    at: previousPreviousAt,
    input,
    rows: bpRows,
  });
  const common = {
    input,
    bpSources: currentBp.sources,
    glucose,
    activity,
    sleep,
    adiposity,
    fitness,
    assessments,
    labs,
  };
  const canonicalWeights = pickCanonicalSourceRows(
    weights.value,
    "weight",
    input.profile.sourcePriorityJson,
    (date) => userDayKey(date, input.profile.timezone),
  ).canonicalRows;
  const target = resolveWeightTargetOverride(input.profile.thresholdsJson);
  const weightGoal = computeWeightGoal({
    rows: canonicalWeights.map((row) => ({
      value: row.value,
      at: row.measuredAt,
      source: row.source,
    })),
    target,
    source: weights.ok ? "live" : "none",
    readFailed: !weights.ok,
    asOf: input.now,
  });
  const current = computeHealthScore({
    asOf: input.now,
    availablePillars,
    pillars: scoreInputsFor({
      ...common,
      asOf: input.now,
      bp: currentBp.envelope,
    }),
    weightGoal,
  });
  const previous = computeHealthScore({
    asOf: previousAt,
    availablePillars,
    pillars: scoreInputsFor({
      ...common,
      asOf: previousAt,
      bp: previousBp.envelope,
    }),
    weightGoal,
  });
  const previousPrevious = computeHealthScore({
    asOf: previousPreviousAt,
    availablePillars,
    pillars: scoreInputsFor({
      ...common,
      asOf: previousPreviousAt,
      bp: previousPreviousBp.envelope,
    }),
    weightGoal,
  });
  const delta = attachScoreDelta(
    current.composite,
    previous.composite,
    previousPrevious.composite,
    input.now,
    current.pillars,
    previous.pillars,
  );
  const itemKey = healthScoreAlgorithmItemKey(current.scoreVersion);
  const dismissal = await capture(
    db.dismissedPriorityItem.findUnique({
      where: { userId_itemKey: { userId: input.userId, itemKey } },
      select: { itemKey: true },
    }),
    null,
    "ALGORITHM_NOTICE",
  );
  return {
    ...current,
    ...delta,
    algorithmNotice: {
      itemKey,
      dismissed: dismissal.value != null,
    },
  };
}
