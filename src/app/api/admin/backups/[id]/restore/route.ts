/**
 * POST /api/admin/backups/[id]/restore — admin-only disaster recovery.
 *
 * After owner and schema validation, one transaction replaces every
 * serialized owner-scoped class: measurements, medication history including the
 * side effects recorded against a drug, mood and rated factors, cycle data,
 * labs/biomarkers, illness history, allergies, family history, workout
 * summaries, and inbound documents. Document content and summary ciphertext are
 * decoded from base64 and persisted verbatim.
 *
 * Metadata-only portable document exports are rejected before mutation; the
 * importer never fabricates content. Audit rows remain outside the wipe, and
 * cache invalidation runs only after the complete restore transaction.
 */
import { Buffer } from "node:buffer";

import { NextRequest } from "next/server";
import { prisma, toJson } from "@/lib/db";
import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { decrypt } from "@/lib/crypto";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptContextToBytes } from "@/lib/labs/biomarker-store";
import { encryptNoteToBytes } from "@/lib/labs/store";
import { defaultUserIdResolver, withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import {
  parseBackupPayload,
  isCompatibleSchemaVersion,
  summarizeBackup,
  type BackupSummary,
} from "@/lib/validations/backup";
import { recomputeUserMoodRollups } from "@/lib/rollups/mood-rollups";
import {
  recomputeUserMedicationCompliance,
  MEDICATION_COMPLIANCE_BACKFILL_DAYS,
} from "@/lib/rollups/medication-compliance-rollups";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { restoreCycleData } from "@/lib/cycle/backup";
import {
  recordUnknownKeys,
  summarizeRestoreSkips,
  type RestoreSkipLog,
  type RestoreSkipSummary,
} from "@/lib/export/restore-skips";
import { restoreProfileData } from "@/lib/export/profile-backup";
import { restoreIntradayProfileData } from "@/lib/export/intraday-profile-backup";
import { restoreHealthScoreData } from "@/lib/export/health-score-backup";
import { restoreVisitsData } from "@/lib/export/visits-backup";
import { restoreVaccinationsData } from "@/lib/export/vaccinations-backup";
import { invalidateUserData } from "@/lib/cache/invalidate";

export const dynamic = "force-dynamic";

interface RestoreResponse {
  restored: true;
  summary: BackupSummary;
  /**
   * What the file carried that this instance could not resolve, named.
   *
   * `links: 0` with an empty list is the normal answer and says so: nothing
   * was dropped. Anything else has to reach the operator's screen, because a
   * restore that quietly loses links looks exactly like one that did not.
   */
  skipped: RestoreSkipSummary;
  cleared: {
    measurements: number;
    medications: number;
    intakeEvents: number;
    moodEntries: number;
    notificationChannels: number;
    pushSubscriptions: number;
    telegramScheduledDeletions: number;
    cycles: number;
    cycleDayLogs: number;
    cycleProfile: number;
    labResults: number;
    biomarkers: number;
    nutrientDays: number;
    illnessEpisodes: number;
    allergies: number;
    familyHistory: number;
    workouts: number;
    documents: number;
    healthProfile: number;
    healthProfileFactRevisions: number;
    customMetrics: number;
    correlationPatterns: number;
    intradayProfiles: number;
    healthScoreRecords: number;
    practitioners: number;
    encounters: number;
    encounterLinks: number;
    vaccinations: number;
    vaccinationLinks: number;
  };
}

function decodeEncryptedBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

const handler = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user: admin } = await requireAdmin();
    const { id } = await params;
    annotate({ action: { name: "admin.backups.restore" }, meta: { id } });

    let body: { confirm?: string } = {};
    try {
      const raw = await request.text();
      if (raw.length > 64 * 1024) {
        return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
      }
      body = JSON.parse(raw) as { confirm?: string };
    } catch {
      return apiError("Invalid JSON body", 400);
    }

    if (body.confirm !== "RESTORE") {
      await auditLog("admin.backups.restore.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { reason: "missing_confirmation", backupId: id },
      });
      return apiError(
        "Confirmation token missing — restoring user data and included instance-wide settings requires confirm: 'RESTORE'",
        422,
      );
    }

    const backup = await prisma.dataBackup.findUnique({
      where: { id },
      include: { user: { select: { id: true, username: true } } },
    });
    if (!backup) {
      await auditLog("admin.backups.restore.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { reason: "not_found", backupId: id },
      });
      throw new HttpError(404, "Backup not found");
    }

    let plaintext: string;
    try {
      plaintext = decrypt(backup.data);
    } catch (err) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: err instanceof Error ? err.message : "decrypt_failed",
        },
      });
      return apiError("Failed to decrypt backup payload", 500);
    }

    let payload;
    try {
      payload = parseBackupPayload(plaintext);
    } catch (err) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: "schema_invalid",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return apiError("Backup payload failed schema validation", 422);
    }

    if (!isCompatibleSchemaVersion(payload.schemaVersion)) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: "incompatible_schema_version",
          schemaVersion: payload.schemaVersion,
        },
      });
      return apiError(
        `Backup schema version '${payload.schemaVersion}' is not supported by this server`,
        422,
      );
    }

    // The payload declares its own owner, and the backup ROW records who the
    // backup was taken for. Those must agree. Taking the owner from the
    // payload alone means the restored-into account is whatever the blob
    // claims — so an admin who selects one user's backup could write into a
    // different account without the interface ever showing it. Both values are
    // already in hand here; refuse on mismatch rather than trusting the blob.
    if (payload.userId !== backup.userId) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: "owner_mismatch",
          declaredOwnerId: payload.userId,
        },
      });
      return apiError(
        "Backup payload declares a different owner than the backup record",
        409,
      );
    }

    // The target of the restore is whoever the backup is for, NOT the
    // admin running the operation. Make sure that user still exists —
    // an upload referencing a since-deleted user would otherwise leave
    // the operation half-done.
    const ownerId = payload.userId;
    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, username: true },
    });
    if (!owner) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId,
          reason: "owner_not_found",
        },
      });
      return apiError(
        `Backup owner '${ownerId}' no longer exists in this DB`,
        422,
      );
    }

    // Audit the *intent* before the transaction begins so the trail
    // describing "an admin is about to restore <user>" survives even
    // if the operation crashes midway.
    await auditLog("admin.backups.restore.start", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        backupId: id,
        ownerId,
        ownerUsername: owner.username,
        snapshotExportedAt: payload.exportedAt,
      },
    });

    // Portable exports intentionally omit document ciphertext. They remain
    // valid upload/download artifacts, but cannot be used to manufacture an
    // InboundDocument row. A DR restore must fail before any delete rather
    // than inventing empty/plaintext content.
    const incompleteDocument = payload.documents.find(
      (document) =>
        document.contentEncrypted === undefined ||
        document.contentSha256 === undefined ||
        document.contentCodec === undefined ||
        document.providerType === undefined ||
        document.reportDate === undefined ||
        document.documentDate === undefined ||
        document.errorReason === undefined ||
        document.summaryEncrypted === undefined ||
        document.summaryGeneratedAt === undefined ||
        document.summaryState === undefined ||
        document.createdAt === undefined ||
        document.updatedAt === undefined,
    );
    if (incompleteDocument) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId,
          reason: "document_ciphertext_missing",
          documentId: incompleteDocument.id,
        },
      });
      return apiError(
        `Document '${incompleteDocument.id}' is metadata-only and cannot be restored`,
        422,
      );
    }

    let outcome: {
      cleared: RestoreResponse["cleared"];
      skipped: RestoreSkipSummary;
    };
    try {
      outcome = await prisma.$transaction(
        async (tx) => {
          // Declared INSIDE the transaction so a rollback takes the report with
          // it. An accumulator that outlived a failed attempt would carry drops
          // that never happened into the next one.
          const skips: RestoreSkipLog = [];

          // Delete every serialized owner-scoped partition before rebuilding it
          // in the same transaction. Child rows either go first for counts or
          // cascade from their serialized parent.
          const intake = await tx.medicationIntakeEvent.deleteMany({
            where: { userId: ownerId },
          });
          const meds = await tx.medication.deleteMany({
            where: { userId: ownerId },
          });
          const measurements = await tx.measurement.deleteMany({
            where: { userId: ownerId },
          });
          const moods = await tx.moodEntry.deleteMany({
            where: { userId: ownerId },
          });
          // v1.4.39 W-MOOD — wipe the persisted mood rollup partition
          // for this owner so the next analytics read doesn't surface
          // pre-restore daily means. The fold below mints fresh rows
          // from the restored mood entries.
          await tx.moodEntryRollup.deleteMany({ where: { userId: ownerId } });
          // v1.4.39.1 — wipe the persisted measurement rollup partition
          // for the same reason. Pre-fix the partition kept the previous
          // owner's daily means even after the underlying measurements
          // were replaced — the chart's `source=rollup` fast-path could
          // surface a stale 30-day mean built from rows that no longer
          // existed. The fold below mints fresh rows from the restored
          // measurement set.
          await tx.measurementRollup.deleteMany({ where: { userId: ownerId } });
          const channels = await tx.notificationChannel.deleteMany({
            where: { userId: ownerId },
          });
          const subs = await tx.pushSubscription.deleteMany({
            where: { userId: ownerId },
          });
          const tgDel = await tx.telegramScheduledDeletion.deleteMany({
            where: { userId: ownerId },
          });
          const documents = await tx.inboundDocument.deleteMany({
            where: { userId: ownerId },
          });
          const workouts = await tx.workout.deleteMany({
            where: { userId: ownerId },
          });
          const familyHistory = await tx.familyHistoryEntry.deleteMany({
            where: { userId: ownerId },
          });
          const allergies = await tx.allergy.deleteMany({
            where: { userId: ownerId },
          });
          const illnessEpisodes = await tx.illnessEpisode.deleteMany({
            where: { userId: ownerId },
          });
          const labResults = await tx.labResult.deleteMany({
            where: { userId: ownerId },
          });
          const biomarkers = await tx.biomarker.deleteMany({
            where: { userId: ownerId },
          });
          // The export has written nutrient day totals since v1.29 and nothing
          // here ever read them back: water and vitamin history was carried in
          // the file, discarded on restore, and the restore reported success.
          const nutrientDays = await tx.nutrientIntakeDay.deleteMany({
            where: { userId: ownerId },
          });

          if (payload.appSettings) {
            const settings = payload.appSettings;
            const settingsData = {
              registrationEnabled: settings.registrationEnabled,
              mfaRequired: settings.mfaRequired,
              defaultLocale: settings.defaultLocale,
              telegramGlobal: settings.telegramGlobal,
              ntfyGlobal: settings.ntfyGlobal,
              webPushGlobal: settings.webPushGlobal,
              webPushVapidPublicKey: settings.webPushVapidPublicKey,
              webPushVapidPrivateKeyEncrypted:
                settings.webPushVapidPrivateKeyEncrypted,
              webPushVapidSubject: settings.webPushVapidSubject,
              apiGlobal: settings.apiGlobal,
              umamiEnabled: settings.umamiEnabled,
              umamiScriptUrl: settings.umamiScriptUrl,
              umamiWebsiteId: settings.umamiWebsiteId,
              glitchtipEnabled: settings.glitchtipEnabled,
              glitchtipDsn: settings.glitchtipDsn,
              glitchtipEnvironment: settings.glitchtipEnvironment,
              reminderLateMinutes: settings.reminderLateMinutes,
              reminderMissedMinutes: settings.reminderMissedMinutes,
              adminAiKeyEncrypted: settings.adminAiKeyEncrypted,
              adminAiModel: settings.adminAiModel,
              adminAiBaseUrl: settings.adminAiBaseUrl,
              adminCodexAccessTokenEncrypted:
                settings.adminCodexAccessTokenEncrypted,
              adminCodexRefreshTokenEncrypted:
                settings.adminCodexRefreshTokenEncrypted,
              adminCodexAccountIdEncrypted:
                settings.adminCodexAccountIdEncrypted,
              adminCodexTokenExpiresAt: settings.adminCodexTokenExpiresAt
                ? new Date(settings.adminCodexTokenExpiresAt)
                : null,
              adminCodexConnectedAt: settings.adminCodexConnectedAt
                ? new Date(settings.adminCodexConnectedAt)
                : null,
              adminCodexConnectionStatus: settings.adminCodexConnectionStatus,
              adminAiInsightsFeedbackSummary:
                settings.adminAiInsightsFeedbackSummary as never,
              defaultUserTimezone: settings.defaultUserTimezone,
              assistantEnabled: settings.assistantEnabled,
              assistantCoachEnabled: settings.assistantCoachEnabled,
              assistantBriefingEnabled: settings.assistantBriefingEnabled,
              assistantInsightStatusEnabled:
                settings.assistantInsightStatusEnabled,
              assistantCorrelationsEnabled:
                settings.assistantCorrelationsEnabled,
              moduleAvailabilityJson: settings.moduleAvailabilityJson as never,
              documentMaxFileBytes: settings.documentMaxFileBytes,
              documentQuotaBytes: BigInt(settings.documentQuotaBytes),
            };
            await tx.appSettings.upsert({
              where: { id: settings.id },
              create: { id: settings.id, ...settingsData },
              update: settingsData,
            });
          }

          const toRestoredMeasurementData = (
            measurement: (typeof payload.measurements)[number],
          ) => ({
            type: measurement.type,
            value: measurement.value,
            valueMin: measurement.valueMin ?? null,
            valueMax: measurement.valueMax ?? null,
            unit: measurement.unit,
            source: measurement.source ?? "MANUAL",
            measuredAt: new Date(measurement.measuredAt),
            notes: null,
            notesEncrypted:
              measurement.notesEncrypted == null
                ? encryptNote(measurement.notes ?? null)
                : decodeEncryptedBytes(measurement.notesEncrypted),
            externalId: measurement.externalId ?? null,
            externalSourceVersion: measurement.externalSourceVersion ?? null,
            // Authority of an Apple Health `stats:` aggregate. A backup
            // written before this field rode the payload carries nothing, and
            // restoring NULL would flatten the authority ladder: an export.xml
            // source-day estimate could then overwrite a native HealthKit
            // statistic, which is the ambiguity migration 0263 already
            // repaired once. Such a row is exactly the case LEGACY_UNKNOWN
            // exists for, so it comes back repairable instead of ambiguous.
            //
            // The gate is scoped exactly as 0263 scoped its backfill and as
            // the cumulative drain scopes its own LEGACY_UNKNOWN writes:
            // Apple Health rows only. Other providers mint `stats:` ids for
            // their cumulative dailies too (Fitbit, Google Health) and have
            // never carried provenance — marking those would invent a state
            // they were never in. Ordinary point rows keep NULL honestly.
            aggregationProvenance: (measurement.aggregationProvenance ??
              (measurement.source === "APPLE_HEALTH" &&
              measurement.externalId?.startsWith("stats:")
                ? "LEGACY_UNKNOWN"
                : null)) as never,
            glucoseContext: (measurement.glucoseContext ?? null) as never,
            sleepStage: (measurement.sleepStage ?? null) as never,
            rhythmClassification: (measurement.rhythmClassification ??
              null) as never,
            deviceType: measurement.deviceType ?? null,
            syncVersion: measurement.syncVersion ?? 1,
            deletedAt: measurement.deletedAt
              ? new Date(measurement.deletedAt)
              : null,
            ...(measurement.createdAt
              ? { createdAt: new Date(measurement.createdAt) }
              : {}),
            ...(measurement.updatedAt
              ? { updatedAt: new Date(measurement.updatedAt) }
              : {}),
          });

          const stableRows = payload.measurements.flatMap((measurement) =>
            measurement.id
              ? [
                  {
                    id: measurement.id,
                    userId: ownerId,
                    ...toRestoredMeasurementData(measurement),
                  },
                ]
              : [],
          );
          const measurementBatchSize = 1_000;
          for (
            let offset = 0;
            offset < stableRows.length;
            offset += measurementBatchSize
          ) {
            await tx.measurement.createMany({
              data: stableRows.slice(offset, offset + measurementBatchSize),
            });
          }

          // v1 payloads did not require stable ids. Preserve their historical
          // natural-key reconciliation without routing canonical v2 rows
          // through it.
          for (const measurement of payload.measurements) {
            if (measurement.id) continue;
            const restoredData = toRestoredMeasurementData(measurement);
            const existing = await tx.measurement.findFirst({
              where: {
                userId: ownerId,
                type: measurement.type,
                source: restoredData.source,
                measuredAt: restoredData.measuredAt,
                sleepStage: restoredData.sleepStage,
              },
              select: { id: true },
            });
            if (existing) {
              await tx.measurement.update({
                where: { id: existing.id, userId: ownerId },
                data: restoredData,
              });
            } else {
              await tx.measurement.create({
                data: { userId: ownerId, ...restoredData },
              });
            }
          }

          const medByName = new Map<string, string>();
          const restoredMedicationIds = new Set<string>();
          for (const m of payload.medications) {
            const created = await tx.medication.create({
              data: {
                ...(m.id ? { id: m.id } : {}),
                userId: ownerId,
                name: m.name,
                dose: m.dose,
                treatmentClass: m.treatmentClass ?? "GENERIC",
                dosesPerUnit: m.dosesPerUnit ?? null,
                unitsPerDose: m.unitsPerDose ?? "1",
                active: m.active ?? true,
                notificationsEnabled: m.notificationsEnabled ?? true,
                pausedAt: m.pausedAt ? new Date(m.pausedAt) : null,
                snoozedUntil: m.snoozedUntil ? new Date(m.snoozedUntil) : null,
                startsOn: m.startsOn ? new Date(m.startsOn) : null,
                endsOn: m.endsOn ? new Date(m.endsOn) : null,
                oneShot: m.oneShot ?? false,
                asNeeded: m.asNeeded ?? false,
                deliveryForm: m.deliveryForm ?? "ORAL",
                trackInjectionSites: m.trackInjectionSites ?? false,
                allowedInjectionSites: m.allowedInjectionSites ?? [],
                liveActivityEnabled: m.liveActivityEnabled ?? false,
                criticalAlarmEnabled: m.criticalAlarmEnabled ?? false,
                atcCode: m.atcCode ?? null,
                rxNormCode: m.rxNormCode ?? null,
                lowStockNotifiedAt: m.lowStockNotifiedAt
                  ? new Date(m.lowStockNotifiedAt)
                  : null,
                lowStockNotifiedThresholdDays:
                  m.lowStockNotifiedThresholdDays ?? null,
                reorderLeadDays: m.reorderLeadDays ?? null,
                externalSource: m.externalSource ?? null,
                externalId: m.externalId ?? null,
                ...(m.createdAt ? { createdAt: new Date(m.createdAt) } : {}),
                ...(m.updatedAt ? { updatedAt: new Date(m.updatedAt) } : {}),
                schedules: {
                  create: m.schedules.map((s) => ({
                    ...(s.id ? { id: s.id } : {}),
                    windowStart: s.windowStart,
                    windowEnd: s.windowEnd,
                    label: s.label ?? null,
                    dose: s.dose ?? null,
                    // #219 — per-schedule units per dose. Prisma coerces the
                    // Decimal string; NULL / absent stays NULL (inherit).
                    unitsPerDose: s.unitsPerDose ?? null,
                    daysOfWeek: s.daysOfWeek ?? null,
                    timesOfDay: s.timesOfDay ?? [],
                    reminderGraceMinutes: s.reminderGraceMinutes ?? null,
                    rrule: s.rrule ?? null,
                    rollingIntervalDays: s.rollingIntervalDays ?? null,
                    scheduleType: s.scheduleType ?? "SCHEDULED",
                    cyclicOnWeeks: s.cyclicOnWeeks ?? null,
                    cyclicOffWeeks: s.cyclicOffWeeks ?? null,
                    doseWindows: (s.doseWindows ?? null) as never,
                  })),
                },
                // Written in the same `create` as the drug, so the FK binds to
                // the id this row actually got. A canonical DR file preserves
                // the medication's id and a portable one mints a fresh cuid;
                // neither case needs the old `medicationId` from the file,
                // which is why the payload does not carry it. The note follows
                // the measurement contract next to it: ciphertext verbatim when
                // the file has it, legacy plaintext encrypted on the way in,
                // and the plaintext column left null either way.
                sideEffects: {
                  create: m.sideEffects.map((s) => ({
                    ...(s.id ? { id: s.id } : {}),
                    userId: ownerId,
                    occurredAt: new Date(s.occurredAt),
                    category: s.category,
                    entry: s.entry,
                    severity: s.severity,
                    notes: null,
                    notesEncrypted:
                      s.notesEncrypted == null
                        ? encryptNote(s.notes ?? null)
                        : decodeEncryptedBytes(s.notesEncrypted),
                    ...(s.createdAt
                      ? { createdAt: new Date(s.createdAt) }
                      : {}),
                  })),
                },
              },
            });
            restoredMedicationIds.add(created.id);
            if (!medByName.has(m.name)) medByName.set(m.name, created.id);
          }

          if (payload.intakeEvents.length > 0) {
            // An event whose medication did not come back used to be mapped to
            // null and filtered away: the dose history came back short and the
            // restore reported success. That is the same silent-drop shape the
            // cycle symptom links had, and it gets the same answer — name the
            // unresolved reference and stop, so the operator learns from the
            // error rather than from a compliance rate that quietly moved.
            const unresolvedMedications = [
              ...new Set(
                payload.intakeEvents
                  .filter(
                    (e) =>
                      !(
                        e.medicationId &&
                        restoredMedicationIds.has(e.medicationId)
                      ) && !medByName.has(e.medication),
                  )
                  .map((e) => e.medicationId ?? e.medication),
              ),
            ];
            if (unresolvedMedications.length > 0) {
              throw new Error(
                `Unknown medication references in intake events: ${unresolvedMedications.join(
                  ", ",
                )}. The backup records doses against medications it does not carry.`,
              );
            }
            const rows = payload.intakeEvents
              .map((e) => {
                const medId =
                  e.medicationId && restoredMedicationIds.has(e.medicationId)
                    ? e.medicationId
                    : medByName.get(e.medication);
                if (!medId) return null;
                return {
                  ...(e.id ? { id: e.id } : {}),
                  userId: ownerId,
                  medicationId: medId,
                  scheduledFor: new Date(e.scheduledFor),
                  takenAt: e.takenAt ? new Date(e.takenAt) : null,
                  skipped: e.skipped ?? false,
                  autoMissed: e.autoMissed ?? false,
                  attributionSource: e.attributionSource ?? "AUTO",
                  source: e.source ?? "WEB",
                  idempotencyKey: e.idempotencyKey ?? null,
                  ...(e.createdAt ? { createdAt: new Date(e.createdAt) } : {}),
                  injectionSite: e.injectionSite ?? null,
                  doseTaken: e.doseTaken ?? null,
                  inventoryConsumption: (e.inventoryConsumption ??
                    null) as never,
                  externalId: e.externalId ?? null,
                  ...(e.updatedAt ? { updatedAt: new Date(e.updatedAt) } : {}),
                  syncVersion: e.syncVersion ?? 0,
                  deletedAt: e.deletedAt ? new Date(e.deletedAt) : null,
                };
              })
              .filter((r): r is NonNullable<typeof r> => r !== null);
            if (rows.length > 0) {
              await tx.medicationIntakeEvent.createMany({ data: rows });
            }
          }

          if (payload.moodEntries.length > 0) {
            const referencedFactorKeys = payload.moodEntries.flatMap((entry) =>
              entry.factors.map((factor) => factor.key),
            );
            const factorKeys = [...new Set(referencedFactorKeys)];
            const referencedTagKeys = payload.moodEntries.flatMap(
              (entry) => entry.structuredTags,
            );
            const tagKeys = [...new Set(referencedTagKeys)];
            // Re-create the account's own tag definitions first. The lookup
            // below used to ask only for the seeded catalogue (`userId: null`),
            // so a single custom rated tag made the whole restore throw
            // "Unknown mood factor keys" — the file was complete and unusable.
            for (const tag of payload.customMoodTags) {
              await tx.moodTag.upsert({
                where: { key: tag.key },
                create: {
                  ...(tag.id ? { id: tag.id } : {}),
                  userId: ownerId,
                  key: tag.key,
                  labelKey: tag.labelKey,
                  categoryId: tag.categoryId,
                  kind: tag.kind,
                  isActive: tag.isActive,
                  icon: tag.icon ?? null,
                  sortOrder: tag.sortOrder,
                  labelEncrypted: tag.labelEncrypted ?? null,
                  scaleMin: tag.scaleMin,
                  scaleMax: tag.scaleMax,
                  inverse: tag.inverse,
                },
                // `key` is globally unique, so a seeded key would collide.
                // Leave the catalogue row alone; the links resolve either way.
                update: {},
              });
            }

            const factorRows =
              factorKeys.length === 0
                ? []
                : await tx.moodTag.findMany({
                    where: {
                      key: { in: factorKeys },
                      kind: "RATED",
                      // The seeded catalogue OR this account's own tags.
                      OR: [{ userId: null }, { userId: ownerId }],
                    },
                    select: { id: true, key: true },
                  });
            const factorByKey = new Map(
              factorRows.map((factor) => [factor.key, factor.id]),
            );
            // A rated tag this instance does not know costs the entry's link to
            // it, not the entry. The mood, the score, the date, the free tags —
            // everything the person logged — comes back; the one rating that
            // has nowhere to attach is dropped and named. Refusing the file
            // instead meant a renamed seeded tag made the whole account
            // unrecoverable.
            recordUnknownKeys(
              skips,
              "moodFactor",
              factorKeys.filter((key) => !factorByKey.has(key)),
              referencedFactorKeys,
            );

            // The BINARY half of the same taxonomy, looked up the same way and
            // reported the same way. It gets its own family because an
            // operator reading the report needs to know whether a rated
            // factor's score or a ticked tag went missing; they are different
            // losses on the same entry.
            const tagRows =
              tagKeys.length === 0
                ? []
                : await tx.moodTag.findMany({
                    where: {
                      key: { in: tagKeys },
                      kind: "BINARY",
                      OR: [{ userId: null }, { userId: ownerId }],
                    },
                    select: { id: true, key: true },
                  });
            const tagByKey = new Map(tagRows.map((tag) => [tag.key, tag.id]));
            recordUnknownKeys(
              skips,
              "moodTag",
              tagKeys.filter((key) => !tagByKey.has(key)),
              referencedTagKeys,
            );

            for (const entry of payload.moodEntries) {
              const moodLoggedAt = new Date(entry.loggedAt);
              const restoredData = {
                date: entry.date,
                mood: entry.mood,
                score: entry.score,
                // The five level-A values, carried the same way `syncVersion`
                // is: absent in the file means the file predates the columns,
                // and an upsert whose update arm stated them would wipe live
                // answers off every matched row when an older backup is
                // restored over a going concern. A file that has them writes
                // them, including an explicit null; a file that does not says
                // nothing. Never derived — filling one in here would put a
                // number the person never gave into a restored row.
                ...(entry.a1 === undefined ? {} : { moodA1: entry.a1 }),
                ...(entry.a2 === undefined ? {} : { stressA2: entry.a2 }),
                ...(entry.a3 === undefined ? {} : { energyA3: entry.a3 }),
                ...(entry.a4 === undefined ? {} : { connectionA4: entry.a4 }),
                ...(entry.a5 === undefined ? {} : { stabilityA5: entry.a5 }),
                tags: entry.tags ?? null,
                // The note comes back the way every other dual-column note
                // does: ciphertext verbatim when the file carries it, and a
                // portable file's plaintext re-encrypted on the way in, with
                // the legacy column left null either way.
                note: null,
                noteEncrypted:
                  entry.noteEncrypted == null
                    ? encryptNote(entry.note ?? null)
                    : decodeEncryptedBytes(entry.noteEncrypted),
                source: entry.source ?? "MOODLOG",
                externalId: entry.externalId ?? null,
                moodLoggedAt,
                // The zone the `date` string is anchored to. A file written
                // before this rode the payload carries nothing, and NULL is
                // what such a row meant anyway: the legacy Europe/Berlin
                // reading. So an old file keeps its old day boundaries and a
                // new one keeps the zone the person actually logged in.
                tz: entry.tz ?? null,
                // Mood reconciles last-writer-wins by `syncVersion`. Restoring
                // at the schema default would hand the next sync round to any
                // paired device still holding a higher number, and the device
                // would overwrite the recovered row with what it had — a
                // restore that loses to the client is worse than one that
                // fails. An old file carries nothing here and keeps the
                // default, which is the value those rows were written with.
                ...(entry.syncVersion === undefined
                  ? {}
                  : { syncVersion: entry.syncVersion }),
                deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
                ...(entry.syncedAt
                  ? { syncedAt: new Date(entry.syncedAt) }
                  : {}),
                ...(entry.createdAt
                  ? { createdAt: new Date(entry.createdAt) }
                  : {}),
                ...(entry.updatedAt
                  ? { updatedAt: new Date(entry.updatedAt) }
                  : {}),
              };
              const createData = { userId: ownerId, ...restoredData };
              const restored = entry.id
                ? await tx.moodEntry.upsert({
                    where: { id: entry.id, userId: ownerId },
                    create: { id: entry.id, ...createData },
                    update: restoredData,
                  })
                : entry.externalId
                  ? await tx.moodEntry.upsert({
                      where: {
                        userId_source_externalId: {
                          userId: ownerId,
                          source: restoredData.source,
                          externalId: entry.externalId,
                        },
                      },
                      create: createData,
                      update: restoredData,
                    })
                  : await tx.moodEntry.upsert({
                      where: {
                        userId_date_moodLoggedAt: {
                          userId: ownerId,
                          date: entry.date,
                          moodLoggedAt,
                        },
                      },
                      create: createData,
                      update: restoredData,
                    });

              // The day context, rebuilt after the entry so it can bind to
              // whatever id that entry actually got. Delete-then-write rather
              // than an upsert with a preserve-when-absent arm: the file
              // states the whole context or states that there was none, and a
              // restored entry carrying half a file's context and half a live
              // row's would be a state neither of them describes.
              await tx.moodContext.deleteMany({
                where: { moodEntryId: restored.id },
              });
              if (entry.context) {
                const context = entry.context;
                await tx.moodContext.create({
                  data: {
                    moodEntryId: restored.id,
                    userId: ownerId,
                    workStatus: context.workStatus ?? null,
                    workMinutes: context.workMinutes ?? null,
                    overtimeMinutes: context.overtimeMinutes ?? null,
                    workLoad: context.workLoad ?? null,
                    workSatisfaction: context.workSatisfaction ?? null,
                    contactCircles: context.contactCircles ?? null,
                    contactForm: context.contactForm ?? null,
                    contactExtent: context.contactExtent ?? null,
                    contactQuality: context.contactQuality ?? null,
                    contactSupport: context.contactSupport ?? null,
                    leisureCategories: context.leisureCategories ?? null,
                    leisureMinutes: context.leisureMinutes ?? null,
                    leisureJoy: context.leisureJoy ?? null,
                    leisureRecovery: context.leisureRecovery ?? null,
                    eventType: context.eventType ?? null,
                    eventValence: context.eventValence ?? null,
                    eventAt: context.eventAt ? new Date(context.eventAt) : null,
                    // The note comes back the way every other dual-column
                    // note does: ciphertext verbatim when the file carries
                    // it, a portable file's plain text re-encrypted on the
                    // way in.
                    notesEncrypted:
                      context.notesEncrypted == null
                        ? encryptNote(context.note ?? null)
                        : decodeEncryptedBytes(context.notesEncrypted),
                  },
                });
              }

              await tx.moodEntryTagLink.deleteMany({
                where: { moodEntryId: restored.id },
              });
              const factorLinks = entry.factors.flatMap((factor) => {
                const moodTagId = factorByKey.get(factor.key);
                return moodTagId
                  ? [
                      {
                        moodEntryId: restored.id,
                        moodTagId,
                        rating: factor.rating,
                      },
                    ]
                  : [];
              });
              // The other arm. A BINARY link carries no score — the presence
              // of the row is the signal — so `rating` is NULL by definition,
              // which is exactly what the backup's old tag-link filter took to
              // mean "nothing here".
              const tagLinks = entry.structuredTags.flatMap((key) => {
                const moodTagId = tagByKey.get(key);
                return moodTagId
                  ? [{ moodEntryId: restored.id, moodTagId, rating: null }]
                  : [];
              });
              const links = [...factorLinks, ...tagLinks];
              if (links.length > 0) {
                await tx.moodEntryTagLink.createMany({ data: links });
              }
            }
          }

          // v1.15.0 — cycle tables (profile + observed spans + day-logs +
          // symptom links). Delete-then-recreate, mirroring the contract
          // above. `notesEncrypted` is restored as ciphertext verbatim.
          const cycleCleared = await restoreCycleData(
            tx,
            ownerId,
            payload,
            skips,
          );

          // Durable self-context + user-defined metrics. Both ends of this pair
          // live in `src/lib/export/profile-backup.ts` beside its builder — a
          // grep of THIS file alone will not find them, exactly as it does not
          // find the cycle restore one line above.
          const profileCleared = await restoreProfileData(tx, ownerId, payload);

          // The hourly shape of a cumulative day. Both ends live in
          // `src/lib/export/intraday-profile-backup.ts` beside its builder, so
          // a grep of THIS file alone will not find them either.
          const intradayCleared = await restoreIntradayProfileData(
            tx,
            ownerId,
            payload,
          );

          // The score as it was shown on each local day. Both ends live in
          // `src/lib/export/health-score-backup.ts`, same as the two above.
          const healthScoreCleared = await restoreHealthScoreData(
            tx,
            ownerId,
            payload,
          );

          const biomarkerByName = new Map<string, string>();
          const restoredBiomarkerIds = new Set<string>();
          for (const biomarker of payload.biomarkers) {
            const created = await tx.biomarker.create({
              data: {
                ...(biomarker.id ? { id: biomarker.id } : {}),
                userId: ownerId,
                name: biomarker.name,
                unit: biomarker.unit,
                lowerBound: biomarker.lowerBound ?? null,
                upperBound: biomarker.upperBound ?? null,
                panel: biomarker.panel ?? null,
                hidden: biomarker.hidden ?? false,
                contextEncrypted:
                  biomarker.context == null
                    ? null
                    : encryptContextToBytes(biomarker.context),
                ...(biomarker.createdAt
                  ? { createdAt: new Date(biomarker.createdAt) }
                  : {}),
                ...(biomarker.updatedAt
                  ? { updatedAt: new Date(biomarker.updatedAt) }
                  : {}),
              },
            });
            biomarkerByName.set(biomarker.name, created.id);
            restoredBiomarkerIds.add(created.id);
          }

          for (const lab of payload.labResults) {
            const biomarkerId =
              lab.biomarkerId !== undefined
                ? lab.biomarkerId === null
                  ? null
                  : restoredBiomarkerIds.has(lab.biomarkerId)
                    ? lab.biomarkerId
                    : undefined
                : lab.biomarkerName
                  ? biomarkerByName.get(lab.biomarkerName)
                  : null;
            if (biomarkerId === undefined) {
              throw new Error(
                `Unknown biomarker reference: ${lab.biomarkerId ?? lab.biomarkerName}`,
              );
            }
            await tx.labResult.create({
              data: {
                ...(lab.id ? { id: lab.id } : {}),
                userId: ownerId,
                biomarkerId: biomarkerId ?? null,
                panel: lab.panel ?? null,
                analyte: lab.analyte,
                value: lab.value ?? null,
                valueText: lab.valueText ?? null,
                unit: lab.unit,
                referenceLow: lab.referenceLow ?? null,
                referenceHigh: lab.referenceHigh ?? null,
                sourceReferenceLow: lab.sourceReferenceLow ?? null,
                sourceReferenceHigh: lab.sourceReferenceHigh ?? null,
                sourceReferenceText: lab.sourceReferenceText ?? null,
                takenAt: new Date(lab.takenAt),
                source: lab.source,
                noteEncrypted:
                  lab.noteEncrypted !== undefined
                    ? lab.noteEncrypted === null
                      ? null
                      : decodeEncryptedBytes(lab.noteEncrypted)
                    : lab.note == null
                      ? null
                      : encryptNoteToBytes(lab.note),
                deletedAt: lab.deletedAt ? new Date(lab.deletedAt) : null,
                ...(lab.createdAt
                  ? { createdAt: new Date(lab.createdAt) }
                  : {}),
                ...(lab.updatedAt
                  ? { updatedAt: new Date(lab.updatedAt) }
                  : {}),
              },
            });
          }

          const episodeIds = new Set(
            payload.illnessEpisodes.map((episode) => episode.id),
          );
          for (const episode of payload.illnessEpisodes) {
            if (
              episode.parentConditionId &&
              !episodeIds.has(episode.parentConditionId)
            ) {
              throw new Error(
                `Unknown illness parent: ${episode.parentConditionId}`,
              );
            }
            await tx.illnessEpisode.create({
              data: {
                id: episode.id,
                userId: ownerId,
                label: episode.label,
                type: episode.type as never,
                lifecycle: episode.lifecycle as never,
                onsetAt: new Date(episode.onsetAt),
                resolvedAt: episode.resolvedAt
                  ? new Date(episode.resolvedAt)
                  : null,
                parentConditionId: null,
                noteEncrypted:
                  episode.noteEncrypted !== undefined
                    ? episode.noteEncrypted === null
                      ? null
                      : decodeEncryptedBytes(episode.noteEncrypted)
                    : episode.note == null
                      ? null
                      : encryptToBytes(episode.note),
                deletedAt: episode.deletedAt
                  ? new Date(episode.deletedAt)
                  : null,
                ...(episode.createdAt
                  ? { createdAt: new Date(episode.createdAt) }
                  : {}),
                ...(episode.updatedAt
                  ? { updatedAt: new Date(episode.updatedAt) }
                  : {}),
              },
            });
          }
          for (const episode of payload.illnessEpisodes) {
            if (episode.parentConditionId) {
              await tx.illnessEpisode.update({
                where: { id: episode.id },
                data: { parentConditionId: episode.parentConditionId },
              });
            }
          }

          const referencedSymptomKeys = payload.illnessEpisodes.flatMap(
            (episode) =>
              episode.dayLogs.flatMap((dayLog) =>
                dayLog.symptoms.map((symptom) => symptom.key),
              ),
          );
          const symptomKeys = [...new Set(referencedSymptomKeys)];
          const symptomRows =
            symptomKeys.length === 0
              ? []
              : await tx.illnessSymptom.findMany({
                  where: { key: { in: symptomKeys } },
                  select: { id: true, key: true },
                });
          const symptomByKey = new Map(
            symptomRows.map((symptom) => [symptom.key, symptom.id]),
          );
          // `IllnessSymptom` has no `userId` column at all — it is a purely
          // seeded catalogue, so a key that will not resolve here can ONLY be
          // catalogue drift and never a definition the file failed to carry.
          // Which makes refusing the file over it the least defensible of the
          // three: the file was never able to supply the missing row.
          recordUnknownKeys(
            skips,
            "illnessSymptom",
            symptomKeys.filter((key) => !symptomByKey.has(key)),
            referencedSymptomKeys,
          );
          for (const episode of payload.illnessEpisodes) {
            for (const dayLog of episode.dayLogs) {
              const symptomLinks = dayLog.symptoms.flatMap((symptom) => {
                const symptomId = symptomByKey.get(symptom.key);
                return symptomId
                  ? [{ symptomId, severity: symptom.severity ?? null }]
                  : [];
              });
              await tx.illnessDayLog.create({
                data: {
                  ...(dayLog.id ? { id: dayLog.id } : {}),
                  userId: ownerId,
                  episodeId: episode.id,
                  date: dayLog.date,
                  functionalImpact: dayLog.functionalImpact ?? null,
                  feverC: dayLog.feverC ?? null,
                  noteEncrypted:
                    dayLog.noteEncrypted !== undefined
                      ? dayLog.noteEncrypted === null
                        ? null
                        : decodeEncryptedBytes(dayLog.noteEncrypted)
                      : dayLog.note == null
                        ? null
                        : encryptToBytes(dayLog.note),
                  tz: dayLog.tz ?? null,
                  deletedAt: dayLog.deletedAt
                    ? new Date(dayLog.deletedAt)
                    : null,
                  ...(dayLog.createdAt
                    ? { createdAt: new Date(dayLog.createdAt) }
                    : {}),
                  ...(dayLog.updatedAt
                    ? { updatedAt: new Date(dayLog.updatedAt) }
                    : {}),
                  ...(symptomLinks.length > 0
                    ? { symptomLinks: { create: symptomLinks } }
                    : {}),
                },
              });
            }
          }

          for (const allergy of payload.allergies) {
            await tx.allergy.create({
              data: {
                id: allergy.id,
                userId: ownerId,
                substance: allergy.substance,
                category: allergy.category as never,
                type: allergy.type as never,
                severity: (allergy.severity ?? null) as never,
                status: allergy.status as never,
                onsetAt: allergy.onsetAt ? new Date(allergy.onsetAt) : null,
                reactionEncrypted:
                  allergy.reactionEncrypted !== undefined
                    ? allergy.reactionEncrypted === null
                      ? null
                      : decodeEncryptedBytes(allergy.reactionEncrypted)
                    : allergy.reaction == null
                      ? null
                      : encryptToBytes(allergy.reaction),
                notesEncrypted:
                  allergy.notesEncrypted !== undefined
                    ? allergy.notesEncrypted === null
                      ? null
                      : decodeEncryptedBytes(allergy.notesEncrypted)
                    : allergy.note == null
                      ? null
                      : encryptToBytes(allergy.note),
                deletedAt: allergy.deletedAt
                  ? new Date(allergy.deletedAt)
                  : null,
                ...(allergy.createdAt
                  ? { createdAt: new Date(allergy.createdAt) }
                  : {}),
                ...(allergy.updatedAt
                  ? { updatedAt: new Date(allergy.updatedAt) }
                  : {}),
              },
            });
          }

          for (const familyEntry of payload.familyHistory) {
            await tx.familyHistoryEntry.create({
              data: {
                id: familyEntry.id,
                userId: ownerId,
                relationship: familyEntry.relationship as never,
                condition: familyEntry.condition,
                ageAtOnset: familyEntry.ageAtOnset ?? null,
                notesEncrypted:
                  familyEntry.note == null
                    ? null
                    : encryptToBytes(familyEntry.note),
                ...(familyEntry.createdAt
                  ? { createdAt: new Date(familyEntry.createdAt) }
                  : {}),
                ...(familyEntry.updatedAt
                  ? { updatedAt: new Date(familyEntry.updatedAt) }
                  : {}),
              },
            });
          }

          if (payload.workouts.length > 0) {
            await tx.workout.createMany({
              data: payload.workouts.map((workout) => ({
                ...(workout.id ? { id: workout.id } : {}),
                userId: ownerId,
                sportType: workout.sportType,
                startedAt: new Date(workout.startedAt),
                endedAt: new Date(workout.endedAt),
                durationSec: workout.durationSec,
                totalEnergyKcal: workout.totalEnergyKcal ?? null,
                totalDistanceM: workout.totalDistanceM ?? null,
                avgHeartRate: workout.avgHeartRate ?? null,
                maxHeartRate: workout.maxHeartRate ?? null,
                minHeartRate: workout.minHeartRate ?? null,
                stepCount: workout.stepCount ?? null,
                elevationM: workout.elevationM ?? null,
                pauseDurationSec: workout.pauseDurationSec ?? null,
                source: workout.source as never,
                externalId: workout.externalId ?? null,
                ...(workout.metadata == null
                  ? {}
                  : { metadata: toJson(workout.metadata) }),
                ...(workout.createdAt
                  ? { createdAt: new Date(workout.createdAt) }
                  : {}),
                ...(workout.updatedAt
                  ? { updatedAt: new Date(workout.updatedAt) }
                  : {}),
              })),
            });
          }

          if (payload.nutrientDays.length > 0) {
            await tx.nutrientIntakeDay.createMany({
              data: payload.nutrientDays.map((n) => ({
                userId: ownerId,
                day: n.day,
                nutrient: n.nutrient,
                amount: n.amount,
                unit: n.unit,
                source: n.source,
              })),
            });
          }

          if (payload.documents.length > 0) {
            await tx.inboundDocument.createMany({
              data: payload.documents.map((document) => ({
                id: document.id,
                userId: ownerId,
                kind: document.kind as never,
                title: document.title ?? null,
                filename: document.filename ?? null,
                mimeType: document.mimeType,
                byteSize: document.byteSize,
                contentEncrypted: decodeEncryptedBytes(
                  document.contentEncrypted!,
                ),
                contentSha256: document.contentSha256 ?? null,
                contentCodec: document.contentCodec!,
                status: document.status as never,
                providerType: document.providerType ?? null,
                reportDate: document.reportDate
                  ? new Date(document.reportDate)
                  : null,
                documentDate: document.documentDate
                  ? new Date(document.documentDate)
                  : null,
                errorReason: document.errorReason ?? null,
                summaryEncrypted: document.summaryEncrypted
                  ? decodeEncryptedBytes(document.summaryEncrypted)
                  : null,
                summaryGeneratedAt: document.summaryGeneratedAt
                  ? new Date(document.summaryGeneratedAt)
                  : null,
                summaryState: document.summaryState as never,
                lastIndexAttemptAt: document.lastIndexAttemptAt
                  ? new Date(document.lastIndexAttemptAt)
                  : null,
                lastIndexOutcome: document.lastIndexOutcome ?? null,
                createdAt: new Date(document.createdAt!),
                updatedAt: new Date(document.updatedAt!),
              })),
            });
          }

          // Visits, the address book and the three link tables. Last on
          // purpose: a link is written only when both of its ends exist, and
          // the documents above are the final far side to land. Both ends of
          // this section live in `src/lib/export/visits-backup.ts`, so a grep
          // of THIS file alone will not find them — the same delegation as the
          // cycle, profile, intraday and score restores above.
          const visitsCleared = await restoreVisitsData(
            tx,
            ownerId,
            payload,
            skips,
          );

          // The immunization log, after the visits: a dose remaps its
          // practitioner and its encounter against rows the branch above has
          // just written, and its document link needs the documents that
          // landed before that. Both ends of this section live in
          // `src/lib/export/vaccinations-backup.ts`.
          const vaccinationsCleared = await restoreVaccinationsData(
            tx,
            ownerId,
            payload,
            skips,
          );

          const cleared = {
            measurements: measurements.count,
            medications: meds.count,
            intakeEvents: intake.count,
            moodEntries: moods.count,
            notificationChannels: channels.count,
            pushSubscriptions: subs.count,
            telegramScheduledDeletions: tgDel.count,
            cycles: cycleCleared.cycles,
            cycleDayLogs: cycleCleared.cycleDayLogs,
            cycleProfile: cycleCleared.cycleProfile,
            labResults: labResults.count,
            biomarkers: biomarkers.count,
            nutrientDays: nutrientDays.count,
            illnessEpisodes: illnessEpisodes.count,
            allergies: allergies.count,
            familyHistory: familyHistory.count,
            workouts: workouts.count,
            documents: documents.count,
            healthProfile: profileCleared.healthProfile,
            healthProfileFactRevisions:
              profileCleared.healthProfileFactRevisions,
            customMetrics: profileCleared.customMetrics,
            correlationPatterns: profileCleared.correlationPatterns,
            intradayProfiles: intradayCleared.intradayProfiles,
            healthScoreRecords: healthScoreCleared.healthScoreRecords,
            practitioners: visitsCleared.practitioners,
            encounters: visitsCleared.encounters,
            encounterLinks: visitsCleared.encounterLinks,
            vaccinations: vaccinationsCleared.vaccinations,
            vaccinationLinks: vaccinationsCleared.vaccinationLinks,
          };
          return { cleared, skipped: summarizeRestoreSkips(skips) };
        },
        {
          maxWait: 10_000,
          timeout: 120_000,
        },
      );
    } catch (err) {
      // Scrub the raw Prisma / driver error from the wire response —
      // even on an admin endpoint, leaking column names, constraint
      // names or query fragments lowers the cost of a future supply-
      // chain attack against this surface. The verbose text still
      // lands in the audit row (admin-readable) and the Wide Event
      // (operator-readable), so root-cause investigation is unaffected.
      const verbose = err instanceof Error ? err.message : String(err);
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId,
          reason: "transaction_failed",
          message: verbose,
        },
      });
      annotate({ meta: { restoreFailReason: verbose } });
      return apiError("Restore failed", 500);
    }

    const { cleared, skipped } = outcome;

    // Pinned shape, not free text: a dashboard can alert on
    // `restoreSkippedLinks > 0` and the key list says which catalogue drifted.
    annotate({
      meta: {
        restoreSkippedLinks: skipped.links,
        restoreSkippedKeys: skipped.catalogueKeys
          .map((entry) => `${entry.catalogue}:${entry.key}`)
          .join(","),
      },
    });

    // v1.4.39.1 — re-fold the persistent measurement rollup tier from
    // the just-restored measurements. Pre-fix the restore left the
    // rollup table empty for the owner, so the dashboard chart's
    // `source=rollup` fast-path silently returned zero buckets until
    // the next worker boot ran the backfill discovery — multi-hour
    // window of empty charts for the operator-restored account. Runs
    // outside the transaction (the 5-year fold would otherwise hold a
    // long write lock) and is best-effort so a populator hiccup never
    // undoes the restore. The boot-time backfill is the safety net.
    if (payload.measurements.length > 0) {
      try {
        await recomputeUserRollups(ownerId);
      } catch (err) {
        annotate({
          meta: {
            measurement_rollup_restore_failed: true,
            measurement_rollup_restore_error:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // v1.4.39 W-MOOD — re-fold the mood rollup tier from the just-
    // restored entries. Runs outside the transaction so the (5-year)
    // fold can't hold a long write lock; best-effort so a populator
    // hiccup doesn't undo the restore. The boot-time backfill is the
    // safety net — if this fails the next worker boot mints the rows.
    if (payload.moodEntries.length > 0) {
      try {
        await recomputeUserMoodRollups(ownerId, { granularities: ["DAY"] });
      } catch (err) {
        annotate({
          meta: {
            mood_rollup_restore_failed: true,
            mood_rollup_restore_error:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // v1.4.39 W-MED — re-fold the medication-compliance rollup tier
    // from the restored intake events. The medication delete inside the
    // transaction already cascaded the existing rollup partition for
    // this owner via the FK, so the fold mints fresh rows. Boot-time
    // backfill is the safety net if this best-effort call fails.
    if (payload.intakeEvents.length > 0) {
      try {
        const restoreUser = await prisma.user.findUnique({
          where: { id: ownerId },
          select: { timezone: true },
        });
        await recomputeUserMedicationCompliance(
          ownerId,
          MEDICATION_COMPLIANCE_BACKFILL_DAYS,
          restoreUser?.timezone ?? null,
        );
      } catch (err) {
        annotate({
          meta: {
            medication_compliance_rollup_restore_failed: true,
            medication_compliance_rollup_restore_error:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    const summary = summarizeBackup(payload);

    await auditLog("admin.backups.restore", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        backupId: id,
        ownerId,
        ownerUsername: owner.username,
        cleared,
        // The durable half of the report. The response reaches whoever was
        // looking at the screen; the audit row is still here next week when
        // someone asks why a day-log lost a symptom.
        skipped,
        restored: {
          measurements: summary.measurements,
          medications: summary.medications,
          intakeEvents: summary.intakeEvents,
          moodEntries: summary.moodEntries,
          cycles: summary.cycles,
          cycleDayLogs: summary.cycleDayLogs,
          labResults: summary.labResults,
          biomarkers: summary.biomarkers,
          nutrientDays: summary.nutrientDays,
          illnessEpisodes: summary.illnessEpisodes,
          illnessDayLogs: summary.illnessDayLogs,
          allergies: summary.allergies,
          familyHistory: summary.familyHistory,
          workouts: summary.workouts,
          documents: summary.documents,
          healthProfile: summary.healthProfile,
          healthProfileFactRevisions: summary.healthProfileFactRevisions,
          customMetrics: summary.customMetrics,
          customMetricEntries: summary.customMetricEntries,
          correlationPatterns: summary.correlationPatterns,
          practitioners: summary.practitioners,
          encounters: summary.encounters,
          encounterLinks: summary.encounterLinks,
          vaccinations: summary.vaccinations,
          vaccinationLinks: summary.vaccinationLinks,
        },
      },
    });

    // The complete transaction succeeded; only now evict owner-scoped caches.
    invalidateUserData(ownerId);

    const response: RestoreResponse = {
      restored: true,
      summary,
      skipped,
      cleared,
    };
    return apiSuccess(response);
  },
);

// `withIdempotency` wraps the apiHandler so a duplicate retry with the
// same `Idempotency-Key` replays the original 200 instead of executing
// the destructive transaction twice. The default resolver picks up
// either the cookie session OR a Bearer token; for an admin endpoint
// only cookie sessions ever get past `requireAdmin()` upstream, but
// keeping the default keeps the contract uniform.
export const POST = withIdempotency(handler, async () => {
  return defaultUserIdResolver();
});
