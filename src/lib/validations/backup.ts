/**
 * Zod schemas + helpers for the per-user `DataBackup` JSON payload.
 *
 * Single source of truth shared by:
 *   - the pg-boss `data-backup` worker that writes a backup,
 *   - `GET /api/admin/backups/[id]/download` that streams it back as JSON,
 *   - `POST /api/admin/backups/upload` that ingests an admin-supplied file,
 *   - `POST /api/admin/backups/[id]/restore` that re-creates DB rows from it.
 *
 * The schema is intentionally permissive about *extra* fields (`.passthrough`)
 * so older snapshots written before a column was added still parse and so
 * future minor additions don't break old admins. Required fields are
 * deliberately tight — any drift surfaces as a validation error rather than
 * a silent data-loss restore.
 *
 * `schemaVersion` is the migration handle. Bump when the on-disk shape
 * changes incompatibly. The current writer (worker) historically did NOT
 * include this field; `parseBackupPayload()` defaults it to "1" so legacy
 * blobs continue to round-trip and the upload validator can still produce
 * a useful summary for them.
 */
import { z } from "zod/v4";
import {
  AllergyCategory,
  AllergySeverity,
  AllergyStatus,
  AllergyType,
  CervicalMucus,
  CervixFirmness,
  CervixOpening,
  CervixPosition,
  ContraceptiveKind,
  CycleTrackingGoal,
  DocumentSummaryState,
  FamilyRelationship,
  FlowLevel,
  GlucoseContext,
  HomeTestResult,
  IllnessLifecycle,
  IllnessType,
  InboundDocumentKind,
  InboundDocumentStatus,
  InjectionSite,
  IntakeAttributionSource,
  IntakeSource,
  MeasurementAggregationProvenance,
  MeasurementSource,
  MeasurementType,
  MedicationCategory,
  MedicationDeliveryForm,
  MedicationScheduleType,
  OvulationTest,
  RhythmClassification,
  SecondarySymptom,
  SleepStage,
} from "@/generated/prisma/enums";

export const BACKUP_SCHEMA_VERSION = "2" as const;
const LEGACY_BACKUP_SCHEMA_VERSION = "1" as const;

const isoDateTime = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "Expected ISO-8601 date-time string",
  });

const base64BytesSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    { message: "Expected base64-encoded encrypted bytes" },
  );

const measurementSchema = z
  .object({
    id: z.string().min(1).optional(),
    type: z.enum(MeasurementType),
    value: z.number(),
    valueMin: z.number().nullable().optional(),
    valueMax: z.number().nullable().optional(),
    unit: z.string().min(1),
    measuredAt: isoDateTime,
    source: z.enum(MeasurementSource).optional(),
    notes: z.string().nullable().optional(),
    notesEncrypted: base64BytesSchema.nullable().optional(),
    externalId: z.string().nullable().optional(),
    externalSourceVersion: z.string().nullable().optional(),
    // Authority of a `stats:` aggregate. `.optional()` keeps every backup
    // written before this field rode the payload parseable.
    aggregationProvenance: z
      .enum(MeasurementAggregationProvenance)
      .nullable()
      .optional(),
    glucoseContext: z.enum(GlucoseContext).nullable().optional(),
    sleepStage: z.enum(SleepStage).nullable().optional(),
    rhythmClassification: z.enum(RhythmClassification).nullable().optional(),
    deviceType: z.string().nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const medicationScheduleSchema = z
  .object({
    id: z.string().min(1).optional(),
    windowStart: z.string().min(1),
    windowEnd: z.string().min(1),
    label: z.string().nullable().optional(),
    dose: z.string().nullable().optional(),
    daysOfWeek: z.string().nullable().optional(),
    timesOfDay: z.array(z.string()).optional(),
    reminderGraceMinutes: z.number().int().nullable().optional(),
    rrule: z.string().nullable().optional(),
    rollingIntervalDays: z.number().int().nullable().optional(),
    scheduleType: z.enum(MedicationScheduleType).optional(),
    cyclicOnWeeks: z.number().int().nullable().optional(),
    cyclicOffWeeks: z.number().int().nullable().optional(),
    doseWindows: z.unknown().nullable().optional(),
  })
  .passthrough();

const medicationSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    dose: z.string(),
    treatmentClass: z.enum(MedicationCategory).optional(),
    dosesPerUnit: z.number().int().nullable().optional(),
    unitsPerDose: z.string().min(1).optional(),
    active: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
    pausedAt: isoDateTime.nullable().optional(),
    snoozedUntil: isoDateTime.nullable().optional(),
    startsOn: isoDateTime.nullable().optional(),
    endsOn: isoDateTime.nullable().optional(),
    oneShot: z.boolean().optional(),
    asNeeded: z.boolean().optional(),
    deliveryForm: z.enum(MedicationDeliveryForm).optional(),
    trackInjectionSites: z.boolean().optional(),
    allowedInjectionSites: z.array(z.enum(InjectionSite)).optional(),
    liveActivityEnabled: z.boolean().optional(),
    criticalAlarmEnabled: z.boolean().optional(),
    atcCode: z.string().nullable().optional(),
    rxNormCode: z.string().nullable().optional(),
    lowStockNotifiedAt: isoDateTime.nullable().optional(),
    lowStockNotifiedThresholdDays: z.number().int().nullable().optional(),
    reorderLeadDays: z.number().int().nullable().optional(),
    externalSource: z.enum(IntakeSource).nullable().optional(),
    externalId: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    schedules: z.array(medicationScheduleSchema).default([]),
  })
  .passthrough();

const intakeEventSchema = z
  .object({
    id: z.string().min(1).optional(),
    medicationId: z.string().min(1).optional(),
    medication: z.string().min(1),
    scheduledFor: isoDateTime,
    takenAt: isoDateTime.nullable().optional(),
    skipped: z.boolean().optional(),
    autoMissed: z.boolean().optional(),
    attributionSource: z.enum(IntakeAttributionSource).optional(),
    source: z.enum(IntakeSource).optional(),
    idempotencyKey: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    injectionSite: z.enum(InjectionSite).nullable().optional(),
    doseTaken: z.string().nullable().optional(),
    inventoryConsumption: z.unknown().nullable().optional(),
    externalId: z.string().nullable().optional(),
    updatedAt: isoDateTime.optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

/**
 * `MoodEntry.tags` is stored as a JSON-array-as-string in the
 * `mood_entries.tags` column ("[\"work\",\"sleep\"]"). The previous
 * schema accepted any `string` here, so a malformed blob in a backup
 * (or one tampered with mid-restore) would land in the DB and crash
 * downstream readers that `JSON.parse` it. We now refine to one of
 * `null` / empty-string (legacy null wire format) / a JSON string
 * that parses to a `string[]`. v1.4.15 H2.
 */
const moodEntryTagsSchema = z
  .union([z.null(), z.string()])
  .nullable()
  .optional()
  .refine(
    (v) => {
      if (v == null || v === "") return true;
      try {
        const parsed = JSON.parse(v) as unknown;
        return (
          Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
        );
      } catch {
        return false;
      }
    },
    { message: "tags must be null, empty, or a JSON array of strings" },
  );

const moodFactorSchema = z
  .object({
    key: z.string().min(1),
    rating: z.number().int(),
  })
  .passthrough();

const moodEntrySchema = z
  .object({
    id: z.string().min(1).optional(),
    date: z.string().min(1),
    mood: z.string().min(1),
    score: z.number().int().min(0).max(10),
    tags: moodEntryTagsSchema,
    source: z.string().min(1).optional(),
    externalId: z.string().nullable().optional(),
    loggedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
    factors: z.array(moodFactorSchema).default([]),
  })
  .passthrough();

/* ── v1.15.0 cycle-tracking backup shapes ──────────────────────────── */

/**
 * One menstrual-cycle span. `startDate` is the natural per-user key
 * (matching the `(userId, startDate)` unique), so a restore upserts on it.
 * Predicted (forecast) rows are excluded from the backup — only observed
 * history round-trips.
 */
const cycleSpanSchema = z
  .object({
    id: z.string().min(1).optional(),
    startDate: z.string().min(1),
    endDate: z.string().nullable().optional(),
    periodEndDate: z.string().nullable().optional(),
    lengthDays: z.number().int().nullable().optional(),
    ovulationDate: z.string().nullable().optional(),
    ovulationConfirmed: z.boolean().optional(),
    isPredicted: z.boolean().optional(),
    tz: z.string().nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * One cycle day-log. `notesEncrypted` is carried as the AES-256-GCM
 * ciphertext envelope verbatim — the backup never decrypts it, so the
 * owner's free-text note round-trips encrypted (and a wrong-surface leak is
 * impossible). `symptomKeys` carries the seeded catalogue keys so the
 * restore can re-link without exporting internal join ids.
 */
const cycleDayLogSchema = z
  .object({
    id: z.string().min(1).optional(),
    date: z.string().min(1),
    cycleId: z.string().nullable().optional(),
    flow: z.enum(FlowLevel).nullable().optional(),
    intermenstrualBleeding: z.boolean().optional(),
    basalBodyTempC: z.number().nullable().optional(),
    temperatureExcluded: z.boolean().optional(),
    ovulationTest: z.enum(OvulationTest).nullable().optional(),
    cervicalMucus: z.enum(CervicalMucus).nullable().optional(),
    cervixPosition: z.enum(CervixPosition).nullable().optional(),
    cervixFirmness: z.enum(CervixFirmness).nullable().optional(),
    cervixOpening: z.enum(CervixOpening).nullable().optional(),
    sexualActivity: z.boolean().optional(),
    protectedSex: z.boolean().nullable().optional(),
    pregnancyTest: z.enum(HomeTestResult).nullable().optional(),
    progesteroneTest: z.enum(HomeTestResult).nullable().optional(),
    contraceptive: z.enum(ContraceptiveKind).nullable().optional(),
    sensitiveEncrypted: z.string().nullable().optional(),
    notesEncrypted: z.string().nullable().optional(),
    source: z.enum(MeasurementSource).optional(),
    externalId: z.string().nullable().optional(),
    tz: z.string().nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    symptomKeys: z.array(z.string()).default([]),
  })
  .passthrough();

/** Cycle-tracking preferences (one row per user). */
const cycleProfileSchema = z
  .object({
    id: z.string().min(1).optional(),
    goal: z.enum(CycleTrackingGoal).optional(),
    cycleTrackingEnabled: z.boolean().nullable().optional(),
    typicalCycleLength: z.number().int().nullable().optional(),
    typicalPeriodLength: z.number().int().nullable().optional(),
    lutealPhaseLength: z.number().int().nullable().optional(),
    secondarySymptom: z.enum(SecondarySymptom).nullable().optional(),
    predictionEnabled: z.boolean().optional(),
    rawChartMode: z.boolean().optional(),
    discreetNotifications: z.boolean().optional(),
    sensitiveCategoryEncryption: z.boolean().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * A mood tag the account created, as opposed to the seeded catalogue.
 *
 * Carried for the same reason as a custom cycle symptom, but the failure it
 * prevents is louder: the restore resolves an entry's rated factors by key and
 * throws on one it cannot find, so an account with a single custom rated tag
 * could not be restored at all.
 */
const customMoodTagSchema = z
  .object({
    id: z.string().min(1).optional(),
    key: z.string().min(1),
    labelKey: z.string().min(1),
    categoryId: z.string().min(1),
    // "BINARY" | "RATED", enforced in app code rather than a DB enum.
    kind: z.string().min(1),
    isActive: z.boolean().default(true),
  })
  .passthrough();

/**
 * A day's total for one nutrient, from one source.
 *
 * The export has written these since v1.29 and the canonical schema never
 * declared them, so `.passthrough()` carried the key through parsing and no
 * reader ever looked at it. The restore therefore dropped every water and
 * vitamin total on the floor while reporting success.
 */
const nutrientDaySchema = z
  .object({
    day: z.string().min(1),
    nutrient: z.string().min(1),
    amount: z.number(),
    unit: z.string().min(1),
    // Closed set in app code rather than a DB enum; kept as a string here so a
    // future source does not make an old file unparseable.
    source: z.string().min(1),
  })
  .passthrough();

/**
 * A symptom the account created, as opposed to the seeded catalogue.
 *
 * Carried because a day-log's symptom link resolves by key: without the
 * definition the key resolves to nothing on the restoring instance, and the
 * link is lost. The seeded rows are deliberately NOT carried — every instance
 * already has them, and shipping them would mean a restore could rewrite
 * another instance's reference data.
 */
const customCycleSymptomSchema = z
  .object({
    id: z.string().min(1).optional(),
    key: z.string().min(1),
    labelKey: z.string().min(1),
    categoryId: z.string().min(1),
    icon: z.string().nullable().optional(),
    sortOrder: z.number().int().default(0),
    isActive: z.boolean().default(true),
  })
  .passthrough();

const appSettingsBackupSchema = z
  .object({
    id: z.string().min(1),
    registrationEnabled: z.boolean(),
    mfaRequired: z.boolean(),
    defaultLocale: z.string(),
    telegramGlobal: z.boolean(),
    ntfyGlobal: z.boolean(),
    webPushGlobal: z.boolean(),
    webPushVapidPublicKey: z.string().nullable(),
    webPushVapidPrivateKeyEncrypted: z.string().nullable(),
    webPushVapidSubject: z.string().nullable(),
    apiGlobal: z.boolean(),
    umamiEnabled: z.boolean(),
    umamiScriptUrl: z.string().nullable(),
    umamiWebsiteId: z.string().nullable(),
    glitchtipEnabled: z.boolean(),
    glitchtipDsn: z.string().nullable(),
    glitchtipEnvironment: z.string().nullable(),
    reminderLateMinutes: z.number().int(),
    reminderMissedMinutes: z.number().int(),
    adminAiKeyEncrypted: z.string().nullable(),
    adminAiModel: z.string(),
    adminAiBaseUrl: z.string(),
    adminCodexAccessTokenEncrypted: z.string().nullable(),
    adminCodexRefreshTokenEncrypted: z.string().nullable(),
    adminCodexAccountIdEncrypted: z.string().nullable(),
    adminCodexTokenExpiresAt: isoDateTime.nullable(),
    adminCodexConnectedAt: isoDateTime.nullable(),
    adminCodexConnectionStatus: z.string(),
    adminAiInsightsFeedbackSummary: z.unknown().nullable(),
    defaultUserTimezone: z.string().nullable(),
    assistantEnabled: z.boolean(),
    assistantCoachEnabled: z.boolean(),
    assistantBriefingEnabled: z.boolean(),
    assistantInsightStatusEnabled: z.boolean(),
    assistantCorrelationsEnabled: z.boolean(),
    assistantHealthScoreExplainerEnabled: z.boolean(),
    moduleAvailabilityJson: z.unknown().nullable(),
    documentMaxFileBytes: z.number().int(),
    documentQuotaBytes: z.string().regex(/^\d+$/),
  })
  .passthrough();

/* ── Structured-record disaster-recovery shapes ─────────────────────
 *
 * These shapes serve both the historical portable export and the canonical
 * weekly/off-host disaster-recovery payload. Portable document entries remain
 * metadata-only. Canonical entries additionally carry encrypted BYTEA values
 * as base64 plus the codec/hash fields required to recreate InboundDocument
 * without decrypting or fabricating content.
 */

const labResultBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    panel: z.string().nullable().optional(),
    analyte: z.string().min(1),
    value: z.number().nullable().optional(),
    valueText: z.string().nullable().optional(),
    unit: z.string().min(1),
    referenceLow: z.number().nullable().optional(),
    referenceHigh: z.number().nullable().optional(),
    takenAt: isoDateTime,
    source: z.string().min(1),
    biomarkerName: z.string().nullable().optional(),
    biomarkerId: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const biomarkerBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    unit: z.string().min(1),
    lowerBound: z.number().nullable().optional(),
    upperBound: z.number().nullable().optional(),
    panel: z.string().nullable().optional(),
    hidden: z.boolean().optional(),
    context: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const illnessSymptomBackupSchema = z
  .object({
    key: z.string().min(1),
    severity: z.number().int().nullable().optional(),
  })
  .passthrough();

const illnessDayLogBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    episodeId: z.string().min(1).optional(),
    date: z.string().min(1),
    functionalImpact: z.number().int().nullable().optional(),
    feverC: z.number().nullable().optional(),
    symptoms: z.array(illnessSymptomBackupSchema).default([]),
    note: z.string().nullable().optional(),
    updatedAt: isoDateTime.optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    tz: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

const illnessEpisodeBackupSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(IllnessType),
    lifecycle: z.enum(IllnessLifecycle),
    onsetAt: isoDateTime,
    resolvedAt: isoDateTime.nullable().optional(),
    // Self-referencing flare/exacerbation link, carried as the exported
    // episode's own id — never resolved against another user's rows.
    parentConditionId: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    updatedAt: isoDateTime.optional(),
    dayLogs: z.array(illnessDayLogBackupSchema).default([]),
  })
  .passthrough();

const allergyBackupSchema = z
  .object({
    id: z.string().min(1),
    substance: z.string().min(1),
    category: z.enum(AllergyCategory),
    type: z.enum(AllergyType),
    severity: z.enum(AllergySeverity).nullable().optional(),
    status: z.enum(AllergyStatus),
    onsetAt: isoDateTime.nullable().optional(),
    reaction: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    reactionEncrypted: base64BytesSchema.nullable().optional(),
    notesEncrypted: base64BytesSchema.nullable().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const familyHistoryBackupSchema = z
  .object({
    id: z.string().min(1),
    relationship: z.enum(FamilyRelationship),
    condition: z.string().min(1),
    ageAtOnset: z.number().int().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const workoutBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    sportType: z.string().min(1),
    startedAt: isoDateTime,
    endedAt: isoDateTime,
    durationSec: z.number().int(),
    totalEnergyKcal: z.number().nullable().optional(),
    totalDistanceM: z.number().nullable().optional(),
    avgHeartRate: z.number().int().nullable().optional(),
    maxHeartRate: z.number().int().nullable().optional(),
    minHeartRate: z.number().int().nullable().optional(),
    stepCount: z.number().int().nullable().optional(),
    elevationM: z.number().nullable().optional(),
    pauseDurationSec: z.number().int().nullable().optional(),
    source: z.enum(MeasurementSource),
    externalId: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const documentBackupSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(InboundDocumentKind),
    title: z.string().nullable().optional(),
    filename: z.string().nullable().optional(),
    mimeType: z.string().min(1),
    byteSize: z.number().int(),
    status: z.enum(InboundDocumentStatus),
    reportDate: z.string().nullable().optional(),
    documentDate: z.string().nullable().optional(),
    contentEncrypted: base64BytesSchema.optional(),
    contentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    contentCodec: z.string().min(1).optional(),
    providerType: z.string().nullable().optional(),
    errorReason: z.string().nullable().optional(),
    summaryEncrypted: base64BytesSchema.nullable().optional(),
    summaryGeneratedAt: isoDateTime.nullable().optional(),
    summaryState: z.enum(DocumentSummaryState).optional(),
    summary: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const backupManifestSchema = z
  .object({
    documents: z
      .object({ included: z.string().min(1), note: z.string().min(1) })
      .passthrough(),
    workouts: z
      .object({ included: z.string().min(1), note: z.string().min(1) })
      .passthrough(),
  })
  .passthrough();

/**
 * Wire shape — exactly what the pg-boss worker writes today, plus a
 * `schemaVersion` field that newer writers stamp explicitly. Older blobs
 * without the field default to v1 in `parseBackupPayload`.
 */
export const backupPayloadSchema = z
  .object({
    schemaVersion: z.string().min(1).default(LEGACY_BACKUP_SCHEMA_VERSION),
    exportedAt: isoDateTime,
    userId: z.string().min(1),
    appSettings: appSettingsBackupSchema.nullable().default(null),
    measurements: z.array(measurementSchema).default([]),
    medications: z.array(medicationSchema).default([]),
    intakeEvents: z.array(intakeEventSchema).default([]),
    moodEntries: z.array(moodEntrySchema).default([]),
    // v1.15.0 — cycle-tracking tables. Default to empty arrays / null so a
    // pre-v1.15 backup (no cycle keys) still round-trips unchanged.
    cycleProfile: cycleProfileSchema.nullable().default(null),
    cycles: z.array(cycleSpanSchema).default([]),
    cycleDayLogs: z.array(cycleDayLogSchema).default([]),
    // Defaulted rather than required: files written before this field existed
    // are still valid, and an account with no custom symptoms writes [].
    customSymptoms: z.array(customCycleSymptomSchema).default([]),
    customMoodTags: z.array(customMoodTagSchema).default([]),
    // Structured records default to empty arrays so older backups remain
    // parseable. Canonical DR writers add stable ids and encrypted document
    // fields; portable exports retain the metadata-only subset.
    labResults: z.array(labResultBackupSchema).default([]),
    biomarkers: z.array(biomarkerBackupSchema).default([]),
    illnessEpisodes: z.array(illnessEpisodeBackupSchema).default([]),
    allergies: z.array(allergyBackupSchema).default([]),
    familyHistory: z.array(familyHistoryBackupSchema).default([]),
    workouts: z.array(workoutBackupSchema).default([]),
    documents: z.array(documentBackupSchema).default([]),
    nutrientDays: z.array(nutrientDaySchema).default([]),
    manifest: backupManifestSchema.nullable().default(null),
  })
  .passthrough()
  .superRefine((payload, ctx) => {
    if (payload.schemaVersion !== BACKUP_SCHEMA_VERSION) return;
    payload.measurements.forEach((measurement, index) => {
      if (!measurement.id) {
        ctx.addIssue({
          code: "custom",
          path: ["measurements", index, "id"],
          message: "Canonical v2 measurements require a stable id",
        });
      }
    });
  });

export type BackupPayload = z.infer<typeof backupPayloadSchema>;

/**
 * Numeric counts of each backed-up record kind. Returned in the
 * upload + restore API responses so the admin sees what they
 * uploaded/restored without having to download the file again.
 */
export interface BackupSummary {
  schemaVersion: string;
  userId: string;
  exportedAt: string;
  measurements: number;
  medications: number;
  intakeEvents: number;
  moodEntries: number;
  /** v1.15.0 — observed cycle spans in the backup. */
  cycles: number;
  /** v1.15.0 — cycle day-logs in the backup. */
  cycleDayLogs: number;
  /** Lab results in the backup. */
  labResults: number;
  nutrientDays: number;
  /** User-scoped biomarker catalog entries in the backup. */
  biomarkers: number;
  /** Illness episodes, including flares/exacerbations. */
  illnessEpisodes: number;
  /** Illness day-logs across every episode. */
  illnessDayLogs: number;
  /** Allergy/intolerance records in the backup. */
  allergies: number;
  /** Family-history entries in the backup. */
  familyHistory: number;
  /** Workout summary records in the backup. */
  workouts: number;
  /** Document records (ciphertext included in canonical DR payloads). */
  documents: number;
}

export function summarizeBackup(payload: BackupPayload): BackupSummary {
  return {
    schemaVersion: payload.schemaVersion,
    userId: payload.userId,
    exportedAt: payload.exportedAt,
    measurements: payload.measurements.length,
    medications: payload.medications.length,
    intakeEvents: payload.intakeEvents.length,
    moodEntries: payload.moodEntries.length,
    cycles: payload.cycles.length,
    cycleDayLogs: payload.cycleDayLogs.length,
    nutrientDays: payload.nutrientDays.length,
    labResults: payload.labResults.length,
    biomarkers: payload.biomarkers.length,
    illnessEpisodes: payload.illnessEpisodes.length,
    illnessDayLogs: payload.illnessEpisodes.reduce(
      (sum, e) => sum + e.dayLogs.length,
      0,
    ),
    allergies: payload.allergies.length,
    familyHistory: payload.familyHistory.length,
    workouts: payload.workouts.length,
    documents: payload.documents.length,
  };
}

/**
 * Parse a JSON blob (string or already-parsed object) against
 * `backupPayloadSchema`, returning a typed payload. Throws ZodError on
 * mismatch — the admin route catches it and turns it into a 422 with a
 * field-level error list.
 *
 * Accepts both forms because:
 *   - the upload route hands us the parsed object after `await req.text()`
 *   - the restore route reads `DataBackup.data` (decrypted) which is
 *     always a JSON string straight from the worker.
 */
export function parseBackupPayload(input: string | unknown): BackupPayload {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  return backupPayloadSchema.parse(raw);
}

/**
 * The schemaVersion the system understands today. Used by the upload
 * route to reject inbound files written by a *future* HealthLog instance
 * — restoring them under the current code might silently drop data the
 * new shape carried.
 */
export function isCompatibleSchemaVersion(version: string): boolean {
  return (
    version === LEGACY_BACKUP_SCHEMA_VERSION ||
    version === BACKUP_SCHEMA_VERSION
  );
}
