/**
 * v1.23 — shared builder for the user-scoped full-backup payload.
 *
 * Extracted so both the plaintext `GET /api/export/full-backup` route and the
 * passphrase-encrypted `POST /api/export/encrypted` route emit the byte-for-byte
 * same shape — the one that the pg-boss `data-backup` worker writes and that
 * `parseBackupPayload()` round-trips on admin restore. Keep this writer in sync
 * with the `data-backup` worker (`src/lib/jobs/reminder-worker.ts`).
 *
 * The decrypted notes are surfaced here (the backup is the human-readable
 * artefact); an admin restore re-encrypts them on re-insert.
 */
import { Buffer } from "node:buffer";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { readNote } from "@/lib/crypto/note-cipher";
import { iterateMeasurementPages } from "@/lib/export/paged-measurements";
import { BACKUP_SCHEMA_VERSION } from "@/lib/validations/backup";
import {
  buildCycleBackupSection,
  type CycleBackupSection,
} from "@/lib/cycle/backup";
import {
  buildRecordsBackupSection,
  countRecordsBackupSection,
  type RecordsBackupCounts,
  type RecordsBackupSection,
} from "@/lib/export/records-backup";
import {
  buildProfileBackupSection,
  countProfileBackupSection,
  type ProfileBackupCounts,
  type ProfileBackupSection,
} from "@/lib/export/profile-backup";
import {
  buildHealthScoreBackupSection,
  countHealthScoreBackupSection,
  type HealthScoreBackupCounts,
  type HealthScoreBackupSection,
} from "@/lib/export/health-score-backup";
import {
  buildIntradayProfileBackupSection,
  countIntradayProfileBackupSection,
  type IntradayProfileBackupCounts,
  type IntradayProfileBackupSection,
} from "@/lib/export/intraday-profile-backup";

export interface FullBackupCounts
  extends
    RecordsBackupCounts,
    ProfileBackupCounts,
    IntradayProfileBackupCounts,
    HealthScoreBackupCounts {
  measurements: number;
  medications: number;
  intakeEvents: number;
  medicationSideEffects: number;
  moodEntries: number;
  cycles: number;
  cycleDayLogs: number;
  nutrientDays: number;
}

export interface FullBackupResult {
  payload: Record<string, unknown>;
  counts: FullBackupCounts;
}

export interface FullBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
  exportedAt?: Date;
}
/**
 * Every restorable `Measurement` scalar. `userId` is deliberately absent — the
 * backup is user-scoped, so the owner is implicit in the query and restored
 * from the target account rather than the payload.
 *
 * Named rather than inlined so `measurement-backup-completeness.test.ts` can
 * compare it field-by-field against the model in `prisma/schema.prisma`. A
 * column added to the model and forgotten here is how the aggregation
 * provenance went missing from disaster-recovery backups for several releases.
 */
const MEASUREMENT_BACKUP_SELECT = {
  id: true,
  type: true,
  value: true,
  valueMin: true,
  valueMax: true,
  unit: true,
  measuredAt: true,
  source: true,
  notes: true,
  notesEncrypted: true,
  externalId: true,
  externalSourceVersion: true,
  aggregationProvenance: true,
  glucoseContext: true,
  sleepStage: true,
  rhythmClassification: true,
  deviceType: true,
  syncVersion: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MeasurementSelect;

/**
 * Build the canonical full-backup payload for `userId`. Portable exports omit
 * tombstones and document ciphertext; disaster-recovery payloads preserve
 * both so weekly and off-host snapshots share one restorable wire format.
 */
export async function buildFullBackupPayload(
  prisma: PrismaClient,
  userId: string,
  options: FullBackupOptions = {},
): Promise<FullBackupResult> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const [
    appSettings,
    measurements,
    medications,
    intakeEvents,
    moodEntries,
    customMoodTags,
    cycle,
    records,
    profile,
    intradayProfiles,
    healthScoreRecords,
    nutrientDays,
  ] = await Promise.all([
    disasterRecovery
      ? prisma.appSettings.findUnique({ where: { id: "singleton" } })
      : Promise.resolve(null),
    (async () => {
      const rows: Array<Record<string, unknown>> = [];
      const pages = iterateMeasurementPages(
        prisma,
        disasterRecovery ? { userId } : { userId, deletedAt: null },
        MEASUREMENT_BACKUP_SELECT,
      );
      for await (const page of pages) {
        for (const measurement of page) {
          rows.push(
            disasterRecovery
              ? {
                  id: measurement.id,
                  type: measurement.type,
                  value: measurement.value,
                  valueMin: measurement.valueMin,
                  valueMax: measurement.valueMax,
                  unit: measurement.unit,
                  measuredAt: measurement.measuredAt.toISOString(),
                  source: measurement.source,
                  notes: measurement.notes,
                  notesEncrypted: measurement.notesEncrypted
                    ? Buffer.from(measurement.notesEncrypted).toString("base64")
                    : null,
                  externalId: measurement.externalId,
                  externalSourceVersion: measurement.externalSourceVersion,
                  aggregationProvenance: measurement.aggregationProvenance,
                  glucoseContext: measurement.glucoseContext,
                  sleepStage: measurement.sleepStage,
                  rhythmClassification: measurement.rhythmClassification,
                  deviceType: measurement.deviceType,
                  syncVersion: measurement.syncVersion,
                  deletedAt: measurement.deletedAt?.toISOString() ?? null,
                  createdAt: measurement.createdAt.toISOString(),
                  updatedAt: measurement.updatedAt.toISOString(),
                }
              : {
                  id: measurement.id,
                  type: measurement.type,
                  value: measurement.value,
                  unit: measurement.unit,
                  measuredAt: measurement.measuredAt.toISOString(),
                  source: measurement.source,
                  notes: readNote(
                    measurement.notesEncrypted,
                    measurement.notes,
                  ),
                  deletedAt: measurement.deletedAt?.toISOString() ?? null,
                },
          );
        }
      }
      return rows;
    })(),
    prisma.medication.findMany({
      where: { userId },
      // Side effects ride INSIDE their medication, exactly as the schedules
      // beside them do. The alternative — a top-level array carrying
      // `medicationId` — would have to survive a restore that mints new
      // medication ids for a portable file, which is the id-remap the intake
      // events already have to work around by drug name. A nested create has
      // no id to remap: Prisma binds the child to whatever id the parent row
      // actually got.
      include: {
        schedules: true,
        sideEffects: { orderBy: { occurredAt: "desc" } },
      },
    }),
    prisma.medicationIntakeEvent.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      include: { medication: { select: { name: true } } },
      orderBy: { scheduledFor: "desc" },
    }),
    prisma.moodEntry.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { moodLoggedAt: "desc" },
      include: {
        tagLinks: {
          where: { rating: { not: null } },
          select: {
            rating: true,
            moodTag: { select: { key: true } },
          },
        },
      },
    }),
    // The account's OWN mood tags. The seeded catalogue is reference data every
    // instance has; a tag the user made lives only here. Without it the restore
    // cannot resolve the entry's factor keys — and unlike the cycle path, which
    // used to drop them silently, the mood path throws, so an account with one
    // custom rated tag could not be restored at all.
    prisma.moodTag.findMany({
      where: { userId },
      orderBy: { key: "asc" },
    }),
    buildCycleBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
    buildRecordsBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
    // Durable self-context, user-defined metrics, and persisted pattern
    // decisions. These account-owned rows cannot be reconstructed from an
    // integration after restore.
    buildProfileBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
    // The hourly shape of a cumulative day. Not derived, despite looking it:
    // the drain folds it out of the per-sample rows in the same transaction
    // that deletes them, so past the grace window nothing can rebuild it.
    buildIntradayProfileBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
    // The score as it was SHOWN on each local day. Reads like a derived tier
    // and is not one: today's number always comes from today's rows, so once
    // the readings behind a past day have moved, nothing can recompute what
    // that day said. The row is the only copy.
    buildHealthScoreBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
    // Nutrient day totals were absent from every export path, which
    // contradicted the schema's own reason for denormalising the unit column
    // ("rows stay self-describing in exports even if the catalog ever drifts").
    // `source` is part of the composite PK, so it has to ride along or a
    // restore cannot tell a manual water entry from a synced day total. The
    // table carries no tombstone, so both purposes read the same shape.
    prisma.nutrientIntakeDay.findMany({
      where: { userId },
      select: {
        day: true,
        nutrient: true,
        amount: true,
        unit: true,
        source: true,
      },
      orderBy: [{ day: "desc" }, { nutrient: "asc" }],
    }),
  ]);

  // Pinned to the section interfaces so the spreads below cannot quietly widen
  // (or narrow) what reaches the wire.
  const cycleSection: CycleBackupSection = cycle;
  const recordsSection: RecordsBackupSection = records;
  const profileSection: ProfileBackupSection = profile;
  const intradaySection: IntradayProfileBackupSection = intradayProfiles;
  const healthScoreSection: HealthScoreBackupSection = healthScoreRecords;

  const payload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: (options.exportedAt ?? new Date()).toISOString(),
    userId,
    appSettings:
      disasterRecovery && appSettings
        ? {
            ...appSettings,
            adminCodexTokenExpiresAt:
              appSettings.adminCodexTokenExpiresAt?.toISOString() ?? null,
            adminCodexConnectedAt:
              appSettings.adminCodexConnectedAt?.toISOString() ?? null,
            documentQuotaBytes: appSettings.documentQuotaBytes.toString(),
          }
        : null,
    measurements,
    medications: medications.map((m) => ({
      ...(disasterRecovery
        ? {
            id: m.id,
            treatmentClass: m.treatmentClass,
            dosesPerUnit: m.dosesPerUnit,
            unitsPerDose: m.unitsPerDose.toString(),
            notificationsEnabled: m.notificationsEnabled,
            pausedAt: m.pausedAt?.toISOString() ?? null,
            snoozedUntil: m.snoozedUntil?.toISOString() ?? null,
            startsOn: m.startsOn?.toISOString() ?? null,
            endsOn: m.endsOn?.toISOString() ?? null,
            oneShot: m.oneShot,
            asNeeded: m.asNeeded,
            deliveryForm: m.deliveryForm,
            trackInjectionSites: m.trackInjectionSites,
            allowedInjectionSites: m.allowedInjectionSites,
            liveActivityEnabled: m.liveActivityEnabled,
            criticalAlarmEnabled: m.criticalAlarmEnabled,
            atcCode: m.atcCode,
            rxNormCode: m.rxNormCode,
            lowStockNotifiedAt: m.lowStockNotifiedAt?.toISOString() ?? null,
            lowStockNotifiedThresholdDays: m.lowStockNotifiedThresholdDays,
            reorderLeadDays: m.reorderLeadDays,
            externalSource: m.externalSource,
            externalId: m.externalId,
            createdAt: m.createdAt.toISOString(),
            updatedAt: m.updatedAt.toISOString(),
          }
        : {}),
      name: m.name,
      dose: m.dose,
      active: m.active,
      schedules: m.schedules.map((s) => ({
        ...(disasterRecovery
          ? {
              id: s.id,
              daysOfWeek: s.daysOfWeek,
              timesOfDay: s.timesOfDay,
              reminderGraceMinutes: s.reminderGraceMinutes,
              rrule: s.rrule,
              rollingIntervalDays: s.rollingIntervalDays,
              scheduleType: s.scheduleType,
              cyclicOnWeeks: s.cyclicOnWeeks,
              cyclicOffWeeks: s.cyclicOffWeeks,
              doseWindows: s.doseWindows,
            }
          : {}),
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label,
        dose: s.dose,
      })),
      // What the person recorded against the drug, and the reason a drug may
      // have been stopped. `notes` is the same dual-column arrangement
      // `Measurement` has and gets the same treatment: a portable export
      // carries the DECRYPTED note and no ciphertext, a disaster-recovery
      // payload carries the ciphertext verbatim plus whatever legacy plaintext
      // the row still holds, and the restore re-encrypts the plaintext case.
      sideEffects: m.sideEffects.map((s) => ({
        ...(disasterRecovery
          ? {
              id: s.id,
              notes: s.notes,
              notesEncrypted: s.notesEncrypted
                ? Buffer.from(s.notesEncrypted).toString("base64")
                : null,
              createdAt: s.createdAt.toISOString(),
            }
          : { notes: readNote(s.notesEncrypted, s.notes) }),
        occurredAt: s.occurredAt.toISOString(),
        category: s.category,
        entry: s.entry,
        severity: s.severity,
      })),
    })),
    intakeEvents: intakeEvents.map((e) => ({
      ...(disasterRecovery
        ? {
            id: e.id,
            medicationId: e.medicationId,
            autoMissed: e.autoMissed,
            attributionSource: e.attributionSource,
            idempotencyKey: e.idempotencyKey,
            createdAt: e.createdAt.toISOString(),
            injectionSite: e.injectionSite,
            doseTaken: e.doseTaken,
            inventoryConsumption: e.inventoryConsumption,
            externalId: e.externalId,
            updatedAt: e.updatedAt.toISOString(),
            syncVersion: e.syncVersion,
            deletedAt: e.deletedAt?.toISOString() ?? null,
          }
        : {}),
      medication: e.medication.name,
      scheduledFor: e.scheduledFor.toISOString(),
      takenAt: e.takenAt?.toISOString() ?? null,
      skipped: e.skipped,
      source: e.source,
    })),
    moodEntries: moodEntries.map((e) => ({
      id: e.id,
      date: e.date,
      mood: e.mood,
      score: e.score,
      tags: e.tags,
      source: e.source,
      loggedAt: e.moodLoggedAt.toISOString(),
      externalId: e.externalId,
      deletedAt: e.deletedAt?.toISOString() ?? null,
      factors: e.tagLinks.map((link) => ({
        key: link.moodTag.key,
        rating: link.rating!,
      })),
    })),
    customMoodTags: customMoodTags.map((tag) => ({
      ...(disasterRecovery ? { id: tag.id } : {}),
      key: tag.key,
      labelKey: tag.labelKey,
      categoryId: tag.categoryId,
      kind: tag.kind,
      isActive: tag.isActive,
      icon: tag.icon,
      sortOrder: tag.sortOrder,
      // Ciphertext verbatim, like every other *Encrypted column in a DR
      // payload: the same instance's key reads it back unchanged.
      labelEncrypted: tag.labelEncrypted,
      scaleMin: tag.scaleMin,
      scaleMax: tag.scaleMax,
      inverse: tag.inverse,
    })),
    // Both sections are SPREAD, not hand-picked key by key.
    //
    // Hand-picking is what lost the custom cycle symptoms. `buildCycleBackupSection`
    // returned them, the wire schema declared them, `restoreCycleData` read them
    // and — since v1.33.1 — THREW on a key it could not resolve. The list of keys
    // copied out here was simply never extended, so every backup written carried
    // `customSymptoms: []`. An account with one custom symptom did not get the
    // silent drop that release removed; it got a restore that failed outright on
    // a key nothing had written back, and the fix was inert in production.
    //
    // Spreading makes the section interface the single declaration of what rides
    // the wire: a field added to `CycleBackupSection` / `RecordsBackupSection`
    // reaches the payload by construction rather than by someone remembering.
    // `manifest` (from the records section) discloses the two deliberate
    // exclusions — document binaries, workout GPS/sample series — in the file
    // itself, not just in the export UI copy.
    ...cycleSection,
    ...recordsSection,
    ...profileSection,
    ...intradaySection,
    ...healthScoreSection,
    nutrientDays: nutrientDays.map((n) => ({
      day: n.day,
      nutrient: n.nutrient,
      amount: n.amount,
      unit: n.unit,
      source: n.source,
    })),
  };

  return {
    payload,
    counts: {
      measurements: measurements.length,
      medications: medications.length,
      intakeEvents: intakeEvents.length,
      medicationSideEffects: medications.reduce(
        (total, m) => total + m.sideEffects.length,
        0,
      ),
      moodEntries: moodEntries.length,
      cycles: cycle.cycles.length,
      cycleDayLogs: cycle.cycleDayLogs.length,
      nutrientDays: nutrientDays.length,
      ...countRecordsBackupSection(records),
      ...countProfileBackupSection(profile),
      ...countIntradayProfileBackupSection(intradayProfiles),
      ...countHealthScoreBackupSection(healthScoreRecords),
    },
  };
}
