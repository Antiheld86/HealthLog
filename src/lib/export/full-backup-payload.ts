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
  buildVisitsBackupSection,
  countVisitsBackupSection,
  type VisitsBackupCounts,
  type VisitsBackupSection,
} from "@/lib/export/visits-backup";
import {
  buildVaccinationsBackupSection,
  countVaccinationsBackupSection,
  type VaccinationsBackupCounts,
  type VaccinationsBackupSection,
} from "@/lib/export/vaccinations-backup";
import {
  buildRemindersBackupSection,
  countRemindersBackupSection,
  type RemindersBackupCounts,
  type RemindersBackupSection,
} from "@/lib/export/reminders-backup";
import {
  buildCoachBackupSection,
  buildCoachMemoryBackupSection,
  countCoachBackupSection,
  countCoachMemoryBackupSection,
  type CoachBackupCounts,
  type CoachBackupSection,
  type CoachMemoryBackupCounts,
  type CoachMemoryBackupSection,
} from "@/lib/export/coach-backup";
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
    HealthScoreBackupCounts,
    VisitsBackupCounts,
    VaccinationsBackupCounts,
    RemindersBackupCounts,
    CoachBackupCounts,
    CoachMemoryBackupCounts {
  measurements: number;
  medications: number;
  intakeEvents: number;
  medicationSideEffects: number;
  medicationPauseEras: number;
  medicationDoseChanges: number;
  medicationInventoryItems: number;
  medicationInventoryEvents: number;
  moodEntries: number;
  customMoodTagCategories: number;
  hiddenMoodTags: number;
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
 * Every restorable `MoodEntry` scalar. `userId` is absent for the same reason
 * it is absent above: the backup is user-scoped and the owner is re-derived
 * from the restoring account.
 *
 * Named rather than inlined so `mood-backup-completeness.test.ts` can compare
 * it field-by-field against the model in `prisma/schema.prisma`, exactly as the
 * measurement guard does for the select above.
 */
const MOOD_ENTRY_BACKUP_SELECT = {
  id: true,
  date: true,
  mood: true,
  score: true,
  moodA1: true,
  stressA2: true,
  energyA3: true,
  connectionA4: true,
  stabilityA5: true,
  tags: true,
  note: true,
  noteEncrypted: true,
  source: true,
  externalId: true,
  moodLoggedAt: true,
  tz: true,
  syncedAt: true,
  syncVersion: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MoodEntrySelect;

/**
 * A structured-tag link, as it rides the wire. The link is carried by the
 * tag's KEY, not by its id: a restore resolves the key against the target
 * instance's catalogue, where the source instance's row id may not exist at
 * all. `kind` comes along so the mapper can split RATED factors from BINARY
 * tags without a second query.
 */
const MOOD_ENTRY_TAG_LINK_SELECT = {
  rating: true,
  moodTag: { select: { key: true, kind: true } },
} as const satisfies Prisma.MoodEntryTagLinkSelect;

/**
 * Every restorable `MoodContext` scalar.
 *
 * `moodEntryId` and `userId` are absent for the reasons the exclusion list in
 * `mood-backup-completeness.test.ts` states: the context rides inside its
 * entry and is re-bound to whatever id that entry got, and the owner is
 * re-derived from the restoring account. The two row stamps are absent for the
 * third reason there — they describe when the sub-row was written, not when
 * the day happened, and the entry already carries the moment that matters.
 *
 * Named rather than inlined so the guard can compare it field-by-field against
 * the model, exactly as it does for the two selects above. This is the whole
 * point of the pair: a column added to `MoodContext` without a line here
 * fails, and it fails in the release that added it.
 */
const MOOD_CONTEXT_BACKUP_SELECT = {
  workStatus: true,
  workMinutes: true,
  overtimeMinutes: true,
  workLoad: true,
  workSatisfaction: true,
  contactCircles: true,
  contactForm: true,
  contactExtent: true,
  contactQuality: true,
  contactSupport: true,
  leisureCategories: true,
  leisureMinutes: true,
  leisureJoy: true,
  leisureRecovery: true,
  eventType: true,
  eventValence: true,
  eventAt: true,
  notesEncrypted: true,
} as const satisfies Prisma.MoodContextSelect;

type BackupMoodContext = Prisma.MoodContextGetPayload<{
  select: typeof MOOD_CONTEXT_BACKUP_SELECT;
}>;

/**
 * One context row, in whichever of the two wire shapes the caller asked for.
 *
 * The split is the same one `Measurement` makes: a disaster-recovery file
 * carries the ciphertext verbatim, because the instance that reads it back
 * holds the key; a portable export carries the plain text, because the point
 * of a portable file is that somebody can read it. Every other column rides in
 * both, since none of them is a storage detail — they are all answers somebody
 * gave.
 *
 * The parameter is spelled `moodContext` rather than `c`, deliberately: the
 * completeness guard proves a selected column reaches a payload by matching
 * `moodContext.<column>`, and a one-letter parameter shared with another
 * mapper in this file would make that matcher unable to fail.
 */
function serialiseMoodContext(
  moodContext: BackupMoodContext,
  disasterRecovery: boolean,
) {
  return {
    ...(disasterRecovery
      ? {
          notesEncrypted: moodContext.notesEncrypted
            ? Buffer.from(moodContext.notesEncrypted).toString("base64")
            : null,
        }
      : { note: readNote(moodContext.notesEncrypted, null) }),
    workStatus: moodContext.workStatus,
    workMinutes: moodContext.workMinutes,
    overtimeMinutes: moodContext.overtimeMinutes,
    workLoad: moodContext.workLoad,
    workSatisfaction: moodContext.workSatisfaction,
    // The two multi-selects ride as the stored JSON string, unparsed. The
    // restore writes the column back verbatim, so a file cannot arrive with a
    // list the parser and the column disagree about.
    contactCircles: moodContext.contactCircles,
    contactForm: moodContext.contactForm,
    contactExtent: moodContext.contactExtent,
    contactQuality: moodContext.contactQuality,
    contactSupport: moodContext.contactSupport,
    leisureCategories: moodContext.leisureCategories,
    leisureMinutes: moodContext.leisureMinutes,
    leisureJoy: moodContext.leisureJoy,
    leisureRecovery: moodContext.leisureRecovery,
    eventType: moodContext.eventType,
    eventValence: moodContext.eventValence,
    eventAt: moodContext.eventAt?.toISOString() ?? null,
  };
}

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
    customMoodTagCategories,
    hiddenMoodTags,
    cycle,
    records,
    profile,
    intradayProfiles,
    healthScoreRecords,
    visits,
    vaccinations,
    reminders,
    coach,
    coachMemory,
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
        pauseEras: { orderBy: { pausedAt: "asc" } },
        doseChanges: { orderBy: { effectiveFrom: "asc" } },
        inventoryItems: { orderBy: { createdAt: "asc" } },
        inventoryEvents: { orderBy: { occurredAt: "asc" } },
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
      select: {
        ...MOOD_ENTRY_BACKUP_SELECT,
        // Every link, not only the rated ones. This read used to filter
        // `rating: { not: null }`, and a BINARY link carries a NULL rating by
        // definition — so the present/absent tags, the kind most people pick,
        // were absent from the file and could not come back from it.
        tagLinks: { select: MOOD_ENTRY_TAG_LINK_SELECT },
        // The day context, when the entry has one. Sparse by design — most
        // entries carry none, and the join answers null on those.
        context: { select: MOOD_CONTEXT_BACKUP_SELECT },
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
    // The account's OWN categories. Seeded ones (`userId: null`) belong to the
    // instance and are deliberately not carried — but a custom tag's
    // `categoryId` is a real foreign key, so a category the account created
    // itself has to travel or the tag above cannot be written at all. Before
    // this section existed, that was not a gap in the restore: it was a
    // constraint violation that took the WHOLE file down with it, so an
    // account that had ever grouped its own mood factors could not be
    // restored.
    prisma.moodTagCategory.findMany({
      where: { userId },
      orderBy: { sortOrder: "asc" },
    }),
    // Which tags the account chose to hide. Carried by KEY rather than id:
    // what people hide is almost always a SEEDED tag, whose id differs on
    // every instance, so an id would resolve to nothing on the way back.
    prisma.moodTagHidden.findMany({
      where: { userId },
      select: { moodTag: { select: { key: true } }, createdAt: true },
      orderBy: { createdAt: "asc" },
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
    // Visits, the address book behind them, and the three link tables. Both
    // ends live in `src/lib/export/visits-backup.ts` beside each other, so a
    // grep of the restore route alone will not find them.
    buildVisitsBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
    // The immunization log and the pages it was transcribed from. Both ends
    // live in `src/lib/export/vaccinations-backup.ts` beside each other, the
    // same arrangement as the visits above and for the same reason.
    buildVaccinationsBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
    // The Vorsorge reminders and their completion ledger (v1.37.20, #223 /
    // iOS #68). Both ends live in `src/lib/export/reminders-backup.ts` beside
    // each other, the same arrangement as the two sections above and for the
    // same reason.
    buildRemindersBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
    // The Coach's conversations, turns and document links. Both ends live in
    // `src/lib/export/coach-backup.ts` beside each other, the same arrangement
    // as the three sections above and for the same reason.
    buildCoachBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
    // What the Coach keeps BETWEEN threads. Runs beside the transcript rather
    // than inside it because the two answer different questions, and because a
    // restore has to write them in that order.
    buildCoachMemoryBackupSection(prisma, userId, {
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
  const visitsSection: VisitsBackupSection = visits;
  const vaccinationsSection: VaccinationsBackupSection = vaccinations;
  const remindersSection: RemindersBackupSection = reminders;
  const coachSection: CoachBackupSection = coach;
  const coachMemorySection: CoachMemoryBackupSection = coachMemory;

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
              // #219 — per-schedule units per dose. Decimal → string like the
              // medication-level column; NULL (inherit) stays NULL.
              unitsPerDose:
                s.unitsPerDose == null ? null : s.unitsPerDose.toString(),
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
      // Nested for the same reason the two above are: a pause era is bound to
      // its medication by id, and a nested create binds it to whatever id the
      // parent actually got.
      //
      // These spans are what separates "stopped taking it" from "was told to
      // stop taking it". Without them the compliance recomputation counts a
      // deliberate pause as missed doses, so a restored account reads as
      // non-adherent for a stretch during which it did exactly what it was
      // told. Nothing else in the payload can reconstruct them: an era is a
      // decision, not an observation, and no intake row records its absence.
      //
      // `resumedAt` stays nullable end to end — an open era means the
      // medication is still paused, and readers run it to `now`.
      pauseEras: m.pauseEras.map((p) => ({
        ...(disasterRecovery ? { id: p.id } : {}),
        pausedAt: p.pausedAt.toISOString(),
        resumedAt: p.resumedAt ? p.resumedAt.toISOString() : null,
        createdAt: p.createdAt.toISOString(),
      })),
      // Titration: when the dose moved, to what, and why. The drug comes
      // back at today's dose either way; without these the ramp that led to
      // it is gone, and that ramp is what a prescriber asks about.
      //
      // The note follows the side-effect contract beside it: a portable
      // export carries the DECRYPTED note and no ciphertext, a
      // disaster-recovery payload carries the ciphertext verbatim plus
      // whatever legacy plaintext the row still holds.
      doseChanges: m.doseChanges.map((d) => ({
        ...(disasterRecovery
          ? {
              id: d.id,
              note: d.note,
              noteEncrypted: d.noteEncrypted
                ? Buffer.from(d.noteEncrypted).toString("base64")
                : null,
            }
          : { note: readNote(d.noteEncrypted, d.note) }),
        effectiveFrom: d.effectiveFrom.toISOString(),
        doseValue: d.doseValue,
        doseUnit: d.doseUnit,
        createdAt: d.createdAt.toISOString(),
      })),
      // The packs on the shelf, and the ledger behind the number on them.
      //
      // `unitsRemaining` is carried VERBATIM rather than recomputed from the
      // events, for the same reason `nextDueAt` is: it is what the server had
      // resolved and what the person was shown. Recomputing on the way back
      // would silently correct a count the account may have adjusted by hand,
      // and would disagree with every low-stock reminder already sent.
      //
      // Both Decimal columns cross the wire as strings. A pack of 0.5 mg
      // halves is a real prescription, and JSON numbers would round it.
      inventoryItems: m.inventoryItems.map((i) => ({
        ...(disasterRecovery
          ? {
              id: i.id,
              notes: i.notes,
              notesEncrypted: i.notesEncrypted
                ? Buffer.from(i.notesEncrypted).toString("base64")
                : null,
            }
          : { notes: readNote(i.notesEncrypted, i.notes) }),
        state: i.state,
        containerType: i.containerType,
        unitsTotal: i.unitsTotal.toString(),
        unitsRemaining: i.unitsRemaining.toString(),
        firstUseAt: i.firstUseAt?.toISOString() ?? null,
        expiresAt: i.expiresAt?.toISOString() ?? null,
        printedExpiry: i.printedExpiry?.toISOString() ?? null,
        purchasedAt: i.purchasedAt?.toISOString() ?? null,
        manufacturer: i.manufacturer,
        doseStrength: i.doseStrength,
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
      })),
      inventoryEvents: m.inventoryEvents.map((e) => ({
        ...(disasterRecovery ? { id: e.id } : {}),
        delta: e.delta,
        reason: e.reason,
        occurredAt: e.occurredAt.toISOString(),
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
    // The parameter is spelled out rather than the `e` every other mapper here
    // uses, and deliberately: `mood-backup-completeness.test.ts` proves a
    // selected column reaches a payload by matching `: moodEntry.`. A matcher
    // on `: e.` would also match the intake-event mapper above it and could
    // therefore never fail.
    moodEntries: moodEntries.map((moodEntry) => {
      // The two link arms partition the entry's links exhaustively: a link is
      // a rated factor when its tag is RATED and it actually carries a score,
      // and a structured tag otherwise. Total on purpose — a malformed link
      // (a RATED tag whose rating went missing) rides as a tag key and comes
      // back NAMED as unresolvable on restore, rather than falling between the
      // two arms and disappearing the way every BINARY link used to.
      const isRatedFactor = (link: (typeof moodEntry.tagLinks)[number]) =>
        link.moodTag.kind === "RATED" && link.rating !== null;

      const factors = moodEntry.tagLinks
        .filter(isRatedFactor)
        .map((tagLink) => ({
          key: tagLink.moodTag.key,
          rating: tagLink.rating as number,
        }));
      // BINARY link keys. Their own array rather than a nullable rating inside
      // `factors`: the restore resolves `factors` against `kind: "RATED"` and
      // reports what it cannot resolve, so a rating-less entry in that array
      // would collide with both. A separate key leaves every backup file
      // written before this parsing and restoring exactly as it did.
      const structuredTags = moodEntry.tagLinks
        .filter((link) => !isRatedFactor(link))
        .map((tagLink) => tagLink.moodTag.key);

      return {
        ...(disasterRecovery
          ? {
              note: moodEntry.note,
              noteEncrypted: moodEntry.noteEncrypted
                ? Buffer.from(moodEntry.noteEncrypted).toString("base64")
                : null,
              syncedAt: moodEntry.syncedAt.toISOString(),
              syncVersion: moodEntry.syncVersion,
              createdAt: moodEntry.createdAt.toISOString(),
              updatedAt: moodEntry.updatedAt.toISOString(),
            }
          : { note: readNote(moodEntry.noteEncrypted, moodEntry.note) }),
        id: moodEntry.id,
        date: moodEntry.date,
        mood: moodEntry.mood,
        score: moodEntry.score,
        // The five level-A values, under the keys the write path takes. Both
        // arms carry them: they are the entry's own answers, not a storage
        // detail, and a portable export that dropped them would hand back a
        // file describing the day less well than the row it came from.
        a1: moodEntry.moodA1,
        a2: moodEntry.stressA2,
        a3: moodEntry.energyA3,
        a4: moodEntry.connectionA4,
        a5: moodEntry.stabilityA5,
        tags: moodEntry.tags,
        source: moodEntry.source,
        loggedAt: moodEntry.moodLoggedAt.toISOString(),
        externalId: moodEntry.externalId,
        // The zone the `date` string is anchored to. Without it a restored row
        // falls back to the legacy Europe/Berlin reading and an account that
        // logged elsewhere gets its day boundaries quietly moved.
        tz: moodEntry.tz,
        deletedAt: moodEntry.deletedAt?.toISOString() ?? null,
        factors,
        structuredTags,
        // The day context, or null. Null rather than an empty object, because
        // "no context" and "a context whose every field is empty" are
        // different facts and the restore has to keep them apart.
        context: moodEntry.context
          ? serialiseMoodContext(moodEntry.context, disasterRecovery)
          : null,
      };
    }),
    customMoodTagCategories: customMoodTagCategories.map((category) => ({
      id: category.id,
      key: category.key,
      labelKey: category.labelKey,
      icon: category.icon,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      // Ciphertext verbatim, like the tag label beside it.
      labelEncrypted: category.labelEncrypted,
    })),
    hiddenMoodTags: hiddenMoodTags.map((hidden) => ({
      key: hidden.moodTag.key,
      createdAt: hidden.createdAt.toISOString(),
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
    ...visitsSection,
    ...vaccinationsSection,
    ...remindersSection,
    ...coachSection,
    ...coachMemorySection,
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
      medicationPauseEras: medications.reduce(
        (total, m) => total + m.pauseEras.length,
        0,
      ),
      medicationDoseChanges: medications.reduce(
        (total, m) => total + m.doseChanges.length,
        0,
      ),
      medicationInventoryItems: medications.reduce(
        (total, m) => total + m.inventoryItems.length,
        0,
      ),
      medicationInventoryEvents: medications.reduce(
        (total, m) => total + m.inventoryEvents.length,
        0,
      ),
      moodEntries: moodEntries.length,
      customMoodTagCategories: customMoodTagCategories.length,
      hiddenMoodTags: hiddenMoodTags.length,
      cycles: cycle.cycles.length,
      cycleDayLogs: cycle.cycleDayLogs.length,
      nutrientDays: nutrientDays.length,
      ...countRecordsBackupSection(records),
      ...countProfileBackupSection(profile),
      ...countIntradayProfileBackupSection(intradayProfiles),
      ...countHealthScoreBackupSection(healthScoreRecords),
      ...countVisitsBackupSection(visits),
      ...countVaccinationsBackupSection(vaccinations),
      ...countRemindersBackupSection(reminders),
      ...countCoachBackupSection(coach),
      ...countCoachMemoryBackupSection(coachMemory),
    },
  };
}
