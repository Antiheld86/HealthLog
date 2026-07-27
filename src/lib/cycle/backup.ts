/**
 * Cycle-tracking backup serialisation — the one place the full-backup
 * writers (the on-demand `GET /api/export/full-backup` route AND the
 * pg-boss `data-backup` worker) read the cycle tables, so the two writers
 * never drift. Mirrors the `backupPayloadSchema` cycle shapes.
 *
 * Reads are scoped to `userId` + `deletedAt: null` and exclude predicted
 * (forecast) cycle rows — only observed history round-trips. `notesEncrypted`
 * is carried as the ciphertext envelope VERBATIM: the backup never decrypts
 * the day-log note, so a wrong-surface plaintext leak is impossible and the
 * owner's note round-trips encrypted at rest.
 */
import type {
  CervicalMucus,
  CervixFirmness,
  CervixOpening,
  CervixPosition,
  ContraceptiveKind,
  CycleTrackingGoal,
  FlowLevel,
  HomeTestResult,
  MeasurementSource,
  OvulationTest,
  Prisma,
  PrismaClient,
  SecondarySymptom,
} from "@/generated/prisma/client";
import type { BackupPayload } from "@/lib/validations/backup";

/** The cycle slice of a backup payload. */
export interface CycleBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

export interface CycleBackupSection {
  cycleProfile: {
    id?: string;
    goal: string;
    cycleTrackingEnabled: boolean | null;
    typicalCycleLength: number | null;
    typicalPeriodLength: number | null;
    lutealPhaseLength: number | null;
    secondarySymptom: string;
    predictionEnabled: boolean;
    rawChartMode: boolean;
    discreetNotifications: boolean;
    sensitiveCategoryEncryption: boolean;
    createdAt?: string;
    updatedAt?: string;
  } | null;
  cycles: Array<{
    id?: string;
    startDate: string;
    endDate: string | null;
    periodEndDate: string | null;
    lengthDays: number | null;
    ovulationDate: string | null;
    ovulationConfirmed: boolean;
    tz: string | null;
    isPredicted?: boolean;
    syncVersion?: number;
    deletedAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }>;
  cycleDayLogs: Array<{
    id?: string;
    cycleId?: string | null;
    date: string;
    flow: string | null;
    intermenstrualBleeding: boolean;
    basalBodyTempC: number | null;
    temperatureExcluded: boolean;
    ovulationTest: string | null;
    cervicalMucus: string | null;
    cervixPosition: string | null;
    cervixFirmness: string | null;
    cervixOpening: string | null;
    sexualActivity: boolean;
    protectedSex: boolean | null;
    pregnancyTest: string | null;
    progesteroneTest: string | null;
    contraceptive: string | null;
    sensitiveEncrypted: string | null;
    notesEncrypted: string | null;
    source: string;
    externalId: string | null;
    tz: string | null;
    syncVersion?: number;
    deletedAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
    symptomKeys: string[];
  }>;
  /**
   * The account's OWN symptom definitions.
   *
   * The seeded catalogue is reference data every instance already has, but a
   * symptom the user created exists only here. Without it the restore looks up
   * a key that resolves to nothing and drops the link — the day-log comes back
   * with one of its symptoms quietly missing.
   */
  customSymptoms: Array<{
    id?: string;
    key: string;
    labelKey: string;
    categoryId: string;
    icon: string | null;
    sortOrder: number;
    isActive: boolean;
    /**
     * The user's own words for the symptom, carried as ciphertext verbatim.
     *
     * The builder has always emitted it and this interface did not declare it,
     * which held while the payload was assembled key by key and stopped holding
     * the moment the section is spread onto the wire: an undeclared field is a
     * field the wire type says is not there. Declared, so the type describes
     * the file.
     */
    labelEncrypted: string | null;
  }>;
}

/**
 * Build the cycle section of a user's full backup. Accepts any client with
 * the cycle delegates (the route's global client OR the worker's local
 * client) so both writers share one read.
 */
export async function buildCycleBackupSection(
  prisma: Pick<
    PrismaClient,
    "cycleProfile" | "menstrualCycle" | "cycleDayLog" | "cycleSymptom"
  >,
  userId: string,
  options: CycleBackupOptions = {},
): Promise<CycleBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const [profile, cycles, dayLogs, customSymptoms] = await Promise.all([
    prisma.cycleProfile.findUnique({ where: { userId } }),
    prisma.menstrualCycle.findMany({
      where: disasterRecovery
        ? { userId }
        : { userId, deletedAt: null, isPredicted: false },
      orderBy: { startDate: "asc" },
    }),
    prisma.cycleDayLog.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { date: "asc" },
      include: {
        symptomLinks: { include: { symptom: { select: { key: true } } } },
      },
    }),
    // `userId` set means the user made it. The NULL rows are the seeded
    // catalogue, which the restoring instance already has.
    prisma.cycleSymptom.findMany({
      where: { userId },
      orderBy: { key: "asc" },
    }),
  ]);

  return {
    cycleProfile: profile
      ? {
          ...(disasterRecovery
            ? {
                id: profile.id,
                createdAt: profile.createdAt.toISOString(),
                updatedAt: profile.updatedAt.toISOString(),
              }
            : {}),
          goal: profile.goal,
          cycleTrackingEnabled: profile.cycleTrackingEnabled,
          typicalCycleLength: profile.typicalCycleLength,
          typicalPeriodLength: profile.typicalPeriodLength,
          lutealPhaseLength: profile.lutealPhaseLength,
          secondarySymptom: profile.secondarySymptom,
          predictionEnabled: profile.predictionEnabled,
          rawChartMode: profile.rawChartMode,
          discreetNotifications: profile.discreetNotifications,
          sensitiveCategoryEncryption: profile.sensitiveCategoryEncryption,
        }
      : null,
    cycles: cycles.map((c) => ({
      ...(disasterRecovery
        ? {
            id: c.id,
            isPredicted: c.isPredicted,
            syncVersion: c.syncVersion,
            deletedAt: c.deletedAt?.toISOString() ?? null,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          }
        : {}),
      startDate: c.startDate,
      endDate: c.endDate,
      periodEndDate: c.periodEndDate,
      lengthDays: c.lengthDays,
      ovulationDate: c.ovulationDate,
      ovulationConfirmed: c.ovulationConfirmed,
      tz: c.tz,
    })),
    cycleDayLogs: dayLogs.map((d) => ({
      ...(disasterRecovery
        ? {
            id: d.id,
            cycleId: d.cycleId,
            syncVersion: d.syncVersion,
            deletedAt: d.deletedAt?.toISOString() ?? null,
            createdAt: d.createdAt.toISOString(),
            updatedAt: d.updatedAt.toISOString(),
          }
        : {}),
      date: d.date,
      flow: d.flow,
      intermenstrualBleeding: d.intermenstrualBleeding,
      basalBodyTempC: d.basalBodyTempC,
      temperatureExcluded: d.temperatureExcluded,
      ovulationTest: d.ovulationTest,
      cervicalMucus: d.cervicalMucus,
      cervixPosition: d.cervixPosition,
      cervixFirmness: d.cervixFirmness,
      cervixOpening: d.cervixOpening,
      sexualActivity: d.sexualActivity,
      protectedSex: d.protectedSex,
      pregnancyTest: d.pregnancyTest,
      progesteroneTest: d.progesteroneTest,
      contraceptive: d.contraceptive,
      sensitiveEncrypted: d.sensitiveEncrypted,
      notesEncrypted: d.notesEncrypted,
      source: d.source,
      externalId: d.externalId,
      tz: d.tz,
      symptomKeys: d.symptomLinks.map((l) => l.symptom.key),
    })),
    customSymptoms: customSymptoms.map((sym) => ({
      ...(disasterRecovery ? { id: sym.id } : {}),
      key: sym.key,
      labelKey: sym.labelKey,
      categoryId: sym.categoryId,
      icon: sym.icon,
      sortOrder: sym.sortOrder,
      isActive: sym.isActive,
      labelEncrypted: sym.labelEncrypted,
    })),
  };
}

/* ── restore ───────────────────────────────────────────────────────── */

/** Counts the cycle restore wiped, for the audit trail. */
export interface CycleRestoreCleared {
  cycles: number;
  cycleDayLogs: number;
  cycleProfile: number;
}

// Closed enum allow-lists. The backup schema is `.passthrough()`, so a
// malformed enum value would otherwise crash deep in `create()`. Guard the
// few enum columns up-front (mirrors the measurement-type guard in the
// restore route). Unknown values are coerced to null rather than failing
// the whole restore — a single drifted field shouldn't strand the rest.
const FLOW_LEVELS = new Set<FlowLevel>([
  "NONE",
  "SPOTTING",
  "LIGHT",
  "MEDIUM",
  "HEAVY",
]);
const OVULATION_TESTS = new Set<OvulationTest>([
  "NEGATIVE",
  "POSITIVE_LH_SURGE",
  "ESTROGEN_SURGE",
  "INDETERMINATE",
]);
const CERVICAL_MUCUS = new Set<CervicalMucus>([
  "DRY",
  "STICKY",
  "CREAMY",
  "WATERY",
  "EGG_WHITE",
]);
const SECONDARY_SYMPTOMS = new Set<SecondarySymptom>(["MUCUS", "CERVIX"]);
const CERVIX_POSITIONS = new Set<CervixPosition>(["LOW", "HIGH"]);
const CERVIX_FIRMNESSES = new Set<CervixFirmness>(["FIRM", "SOFT"]);
const CERVIX_OPENINGS = new Set<CervixOpening>(["CLOSED", "OPEN"]);
const HOME_TESTS = new Set<HomeTestResult>([
  "NEGATIVE",
  "POSITIVE",
  "INDETERMINATE",
]);
const CONTRACEPTIVES = new Set<ContraceptiveKind>([
  "NONE",
  "UNSPECIFIED",
  "IMPLANT",
  "INJECTION",
  "IUD",
  "INTRAVAGINAL_RING",
  "ORAL",
  "PATCH",
  "EMERGENCY",
]);
const CYCLE_SOURCES = new Set<MeasurementSource>([
  "MANUAL",
  "WITHINGS",
  "IMPORT",
  "APPLE_HEALTH",
]);
const CYCLE_GOALS = new Set<CycleTrackingGoal>([
  "GENERAL_HEALTH",
  "AVOID_PREGNANCY",
  "TRYING_TO_CONCEIVE",
  "PERIMENOPAUSE",
  "OFF",
]);

function enumOrNull<T extends string>(
  value: string | null | undefined,
  allow: ReadonlySet<T>,
): T | null {
  return value != null && (allow as ReadonlySet<string>).has(value)
    ? (value as T)
    : null;
}

/**
 * Restore the cycle tables for `ownerId` from a parsed backup payload,
 * inside an existing transaction. Delete-then-recreate, matching the
 * measurement/mood restore contract. Symptom links are re-resolved against
 * the seeded catalogue by key (unknown keys dropped). `notesEncrypted` is
 * written back as the ciphertext envelope verbatim — never re-encrypted.
 *
 * Returns the wiped counts for the audit trail. A pre-v1.15 payload (empty
 * cycle arrays + null profile) wipes nothing and recreates nothing.
 */
export async function restoreCycleData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: BackupPayload,
): Promise<CycleRestoreCleared> {
  // Wipe (child links cascade off the day-log delete).
  const dayLogs = await tx.cycleDayLog.deleteMany({
    where: { userId: ownerId },
  });
  const cycles = await tx.menstrualCycle.deleteMany({
    where: { userId: ownerId },
  });
  const profile = await tx.cycleProfile.deleteMany({
    where: { userId: ownerId },
  });

  // Recreate the profile (one row / user).
  if (payload.cycleProfile) {
    const p = payload.cycleProfile;
    await tx.cycleProfile.create({
      data: {
        ...(p.id ? { id: p.id } : {}),
        userId: ownerId,
        goal: enumOrNull(p.goal, CYCLE_GOALS) ?? "GENERAL_HEALTH",
        cycleTrackingEnabled: p.cycleTrackingEnabled ?? null,
        typicalCycleLength: p.typicalCycleLength ?? null,
        typicalPeriodLength: p.typicalPeriodLength ?? null,
        lutealPhaseLength: p.lutealPhaseLength ?? null,
        secondarySymptom:
          enumOrNull(p.secondarySymptom, SECONDARY_SYMPTOMS) ?? "MUCUS",
        predictionEnabled: p.predictionEnabled ?? true,
        rawChartMode: p.rawChartMode ?? false,
        discreetNotifications: p.discreetNotifications ?? false,
        sensitiveCategoryEncryption: p.sensitiveCategoryEncryption ?? true,
        ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}),
        ...(p.updatedAt ? { updatedAt: new Date(p.updatedAt) } : {}),
      },
    });
  }

  // Recreate observed cycle spans; map startDate → id so day-logs can
  // re-attach to their owning span.
  const cycleIdByStart = new Map<string, string>();
  const restoredCycleIds = new Set<string>();
  for (const c of payload.cycles) {
    const created = await tx.menstrualCycle.create({
      data: {
        ...(c.id ? { id: c.id } : {}),
        userId: ownerId,
        startDate: c.startDate,
        endDate: c.endDate ?? null,
        periodEndDate: c.periodEndDate ?? null,
        lengthDays: c.lengthDays ?? null,
        ovulationDate: c.ovulationDate ?? null,
        ovulationConfirmed: c.ovulationConfirmed ?? false,
        tz: c.tz ?? null,
        isPredicted: c.isPredicted ?? false,
        syncVersion: c.syncVersion ?? 0,
        deletedAt: c.deletedAt ? new Date(c.deletedAt) : null,
        ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
        ...(c.updatedAt ? { updatedAt: new Date(c.updatedAt) } : {}),
      },
    });
    cycleIdByStart.set(c.startDate, created.id);
    restoredCycleIds.add(created.id);
  }

  // Re-create the account's own symptom definitions BEFORE resolving links.
  // The seeded catalogue is already on this instance; a symptom the user made
  // exists only in the file, and a link cannot resolve to a row that was never
  // written back.
  for (const sym of payload.customSymptoms ?? []) {
    await tx.cycleSymptom.upsert({
      where: { key: sym.key },
      create: {
        ...(sym.id ? { id: sym.id } : {}),
        userId: ownerId,
        key: sym.key,
        labelKey: sym.labelKey,
        categoryId: sym.categoryId,
        icon: sym.icon ?? null,
        sortOrder: sym.sortOrder,
        isActive: sym.isActive,
        labelEncrypted: sym.labelEncrypted ?? null,
      },
      // `key` is globally unique, so a seeded key would collide. Leave the
      // catalogue row alone: the account's links resolve against it either way.
      update: {},
    });
  }

  // Resolve the symptom catalogue once for the link re-creation.
  const allKeys = Array.from(
    new Set(payload.cycleDayLogs.flatMap((d) => d.symptomKeys ?? [])),
  );
  const symptomIdByKey = new Map<string, string>();
  if (allKeys.length > 0) {
    const rows = await tx.cycleSymptom.findMany({
      where: {
        key: { in: allKeys },
        OR: [{ userId: null }, { userId: ownerId }],
      },
      select: { id: true, key: true },
    });
    for (const r of rows) symptomIdByKey.set(r.key, r.id);

    // Three lines below, an unknown CYCLE reference throws. An unknown symptom
    // used to be filtered out instead: the day-log came back with one of its
    // symptoms quietly missing, and the restore reported success. Same
    // function, same class of missing reference, two different answers — so
    // this one is loud now too.
    const unresolved = allKeys.filter((k) => !symptomIdByKey.has(k));
    if (unresolved.length > 0) {
      throw new Error(
        `Unknown cycle symptom keys: ${unresolved.join(", ")}. ` +
          "The backup references symptoms that are neither in this instance's " +
          "seeded catalogue nor carried in the file.",
      );
    }
  }

  // Recreate day-logs (with symptom links). The owning cycle is the latest
  // span whose start is on/before the day (the cycle-attribution rule).
  const sortedStarts = payload.cycles
    .map((c) => c.startDate)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const owningCycleId = (date: string): string | null => {
    let id: string | null = null;
    for (const start of sortedStarts) {
      if (start <= date) id = cycleIdByStart.get(start) ?? id;
      else break;
    }
    return id;
  };

  for (const d of payload.cycleDayLogs) {
    // Every key was proven resolvable above, so this maps rather than filters:
    // a `.filter(Boolean)` here would silently re-open the hole that check
    // just closed.
    const symptomIds = (d.symptomKeys ?? []).map((k) => {
      const id = symptomIdByKey.get(k);
      if (!id) throw new Error(`Unresolved cycle symptom key: ${k}`);
      return id;
    });
    const cycleId =
      d.cycleId !== undefined
        ? d.cycleId === null
          ? null
          : restoredCycleIds.has(d.cycleId)
            ? d.cycleId
            : (() => {
                throw new Error(`Unknown cycle reference: ${d.cycleId}`);
              })()
        : owningCycleId(d.date);
    await tx.cycleDayLog.create({
      data: {
        ...(d.id ? { id: d.id } : {}),
        userId: ownerId,
        date: d.date,
        cycleId,
        flow: enumOrNull(d.flow, FLOW_LEVELS),
        intermenstrualBleeding: d.intermenstrualBleeding ?? false,
        basalBodyTempC: d.basalBodyTempC ?? null,
        temperatureExcluded: d.temperatureExcluded ?? false,
        ovulationTest: enumOrNull(d.ovulationTest, OVULATION_TESTS),
        cervicalMucus: enumOrNull(d.cervicalMucus, CERVICAL_MUCUS),
        cervixPosition: enumOrNull(d.cervixPosition, CERVIX_POSITIONS),
        cervixFirmness: enumOrNull(d.cervixFirmness, CERVIX_FIRMNESSES),
        cervixOpening: enumOrNull(d.cervixOpening, CERVIX_OPENINGS),
        sexualActivity: d.sexualActivity ?? false,
        protectedSex: d.protectedSex ?? null,
        pregnancyTest: enumOrNull(d.pregnancyTest, HOME_TESTS),
        progesteroneTest: enumOrNull(d.progesteroneTest, HOME_TESTS),
        contraceptive: enumOrNull(d.contraceptive, CONTRACEPTIVES),
        // Both ciphertext envelopes written back verbatim — never re-encrypted.
        sensitiveEncrypted: d.sensitiveEncrypted ?? null,
        notesEncrypted: d.notesEncrypted ?? null,
        source: enumOrNull(d.source, CYCLE_SOURCES) ?? "MANUAL",
        externalId: d.externalId ?? null,
        tz: d.tz ?? null,
        syncVersion: d.syncVersion ?? 0,
        deletedAt: d.deletedAt ? new Date(d.deletedAt) : null,
        ...(d.createdAt ? { createdAt: new Date(d.createdAt) } : {}),
        ...(d.updatedAt ? { updatedAt: new Date(d.updatedAt) } : {}),
        ...(symptomIds.length > 0
          ? {
              symptomLinks: {
                create: symptomIds.map((symptomId) => ({ symptomId })),
              },
            }
          : {}),
      },
    });
  }

  return {
    cycles: cycles.count,
    cycleDayLogs: dayLogs.count,
    cycleProfile: profile.count,
  };
}
