/**
 * The Vorsorge reminders and their completion ledger, with both backup ends
 * in one file.
 *
 * Same arrangement as `visits-backup.ts` and `vaccinations-backup.ts`, for
 * the same reason: a reader asking "is this carried at both ends?" answers it
 * here, and a reader who greps only the restore ROUTE gets a false negative
 * because the route delegates.
 *
 * Two models ride: the reminder and the ledger row behind it
 * (v1.37.20, #223 / iOS #68). Both are carried rather than owed. The
 * reminder spent its time on the coverage-pending register — "a restore
 * leaves the account silent until each one is set up again" — and the ledger
 * raised the cost of that debt the release it landed: the engine is
 * single-cursor, so the ledger is the ONLY copy of every satisfy and skip
 * before the latest one. A restore without this section hands back a silent
 * account with no history of it ever having been diligent.
 *
 * Each model uses its own named select constant and its own delegate call.
 * `events` is a relation field name here and nowhere else today, but the
 * delegate-per-model shape is kept anyway — `documentLinks` taught this
 * directory what a shared relation name does to a structural matcher.
 *
 * One reference needs care on the way back: `MeasurementReminderEvent.reminderId`
 * addresses a reminder in this same section. The builder filters the ledger to
 * the reminders it actually carries — a portable export omits tombstoned
 * reminders, and a ledger row whose reminder is not in the file could never
 * restore — so a file this release writes always resolves completely. A
 * hand-edited or truncated file that does not is reported, never guessed at.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type {
  MeasurementReminderEventKind,
  MeasurementType,
  ReminderOrigin,
} from "@/generated/prisma/client";

import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

export interface RemindersBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** One configured Vorsorge cadence, exactly as the engine holds it. */
export interface MeasurementReminderBackupEntry {
  /** Always carried: the ledger rows, an encounter and a vaccination record
   *  all address a reminder by it. */
  id: string;
  label: string;
  measurementType: MeasurementType | null;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: string | null;
  endsOn: string | null;
  origin: ReminderOrigin;
  notifyHour: number;
  location: string | null;
  /** Server-computed and carried as computed — the restore writes it back
   *  verbatim rather than recomputing, so the account resumes exactly the
   *  due-state it was exported with. */
  nextDueAt: string | null;
  lastSatisfiedAt: string | null;
  enabled: boolean;
  vaccinationAntigen: string | null;
  /** v1.37.20 — the snooze cursor. Verbatim: a snooze that has since expired
   *  restores as an instant in the past, which every consumer already treats
   *  as "not snoozed". */
  snoozedUntil: string | null;
  /** v1.37.20 — last honest skip. Never folded into `lastSatisfiedAt`; done
   *  and skipped stay distinguishable through a restore too. */
  lastSkippedAt: string | null;
  /** v1.37.20 — lifetime skip counter. */
  skipCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/** One completion-ledger row: an honest satisfy or an honest skip. */
export interface MeasurementReminderEventBackupEntry {
  id: string;
  reminderId: string;
  kind: MeasurementReminderEventKind;
  occurredAt: string;
  /** Derived at write time against the pre-event `nextDueAt`, which is gone.
   *  Carried verbatim because nothing can ever re-derive it. */
  onTime: boolean;
  source: string;
  createdAt: string;
}

export interface RemindersBackupSection {
  measurementReminders: MeasurementReminderBackupEntry[];
  measurementReminderEvents: MeasurementReminderEventBackupEntry[];
}

export interface RemindersBackupCounts {
  measurementReminders: number;
  measurementReminderEvents: number;
}

/**
 * Named select constants, one per model — a structural matcher binds a model
 * to the literal beside its delegate call, matching the other section files.
 */
const MEASUREMENT_REMINDER_BACKUP_SELECT = {
  id: true,
  label: true,
  measurementType: true,
  intervalDays: true,
  rrule: true,
  anchorDate: true,
  endsOn: true,
  origin: true,
  notifyHour: true,
  location: true,
  nextDueAt: true,
  lastSatisfiedAt: true,
  enabled: true,
  vaccinationAntigen: true,
  snoozedUntil: true,
  lastSkippedAt: true,
  skipCount: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

const MEASUREMENT_REMINDER_EVENT_BACKUP_SELECT = {
  id: true,
  reminderId: true,
  kind: true,
  occurredAt: true,
  onTime: true,
  source: true,
  createdAt: true,
} as const;

/**
 * Build the reminders slice of a user's full backup.
 *
 * Takes the delegates it uses rather than a whole client, matching the other
 * section builders. A portable export omits tombstoned reminders so a restore
 * cannot resurrect them — and it omits the ledger rows of an omitted reminder
 * with it, because a ledger row whose reminder is not in the file could only
 * ever restore as a reported drop. A disaster-recovery payload keeps both so
 * the account comes back as itself.
 */
export async function buildRemindersBackupSection(
  prisma: Pick<
    PrismaClient,
    "measurementReminder" | "measurementReminderEvent"
  >,
  userId: string,
  options: RemindersBackupOptions = {},
): Promise<RemindersBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  const [reminderRows, eventRows] = await Promise.all([
    prisma.measurementReminder.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: MEASUREMENT_REMINDER_BACKUP_SELECT,
    }),
    prisma.measurementReminderEvent.findMany({
      where: { userId },
      orderBy: { occurredAt: "asc" },
      select: MEASUREMENT_REMINDER_EVENT_BACKUP_SELECT,
    }),
  ]);

  // The ledger is filtered to the reminders the file actually carries. On a
  // DR payload every reminder is carried and this is a no-op; on a portable
  // export it removes the ledger of each omitted tombstone, so the file never
  // states an event against a reminder it refuses to restore.
  const carriedReminderIds = new Set(reminderRows.map((row) => row.id));

  return {
    measurementReminders: reminderRows.map((row) => ({
      id: row.id,
      label: row.label,
      measurementType: row.measurementType,
      intervalDays: row.intervalDays,
      rrule: row.rrule,
      anchorDate: row.anchorDate?.toISOString() ?? null,
      endsOn: row.endsOn?.toISOString() ?? null,
      origin: row.origin,
      notifyHour: row.notifyHour,
      location: row.location,
      nextDueAt: row.nextDueAt?.toISOString() ?? null,
      lastSatisfiedAt: row.lastSatisfiedAt?.toISOString() ?? null,
      enabled: row.enabled,
      vaccinationAntigen: row.vaccinationAntigen,
      snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
      lastSkippedAt: row.lastSkippedAt?.toISOString() ?? null,
      skipCount: row.skipCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(disasterRecovery
        ? { deletedAt: row.deletedAt?.toISOString() ?? null }
        : {}),
    })),
    measurementReminderEvents: eventRows
      .filter((row) => carriedReminderIds.has(row.reminderId))
      .map((row) => ({
        id: row.id,
        reminderId: row.reminderId,
        kind: row.kind,
        occurredAt: row.occurredAt.toISOString(),
        onTime: row.onTime,
        source: row.source,
        createdAt: row.createdAt.toISOString(),
      })),
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countRemindersBackupSection(
  section: RemindersBackupSection,
): RemindersBackupCounts {
  return {
    measurementReminders: section.measurementReminders.length,
    measurementReminderEvents: section.measurementReminderEvents.length,
  };
}

/** Counts the reminder restore wiped, for the audit trail. */
export interface RemindersRestoreCleared {
  measurementReminders: number;
  measurementReminderEvents: number;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Required rather than optional: the payload schema defaults every key, so
 * every caller already satisfies this, and one that stops satisfying it fails
 * to compile instead of passing `undefined` into a loop that iterates zero
 * times and reports success.
 */
export interface RemindersRestoreInput {
  measurementReminders: RestoredMeasurementReminder[];
  measurementReminderEvents: RestoredMeasurementReminderEvent[];
}

/**
 * What the restore reads, as the parsed file actually presents it — a wider
 * set than what this release writes: a portable export omits the tombstone,
 * and every optional column arrives as `undefined` rather than `null`.
 */
type OptionalNullable<T> = { [K in keyof T]?: T[K] | undefined };

export type RestoredMeasurementReminder = Pick<
  MeasurementReminderBackupEntry,
  "id" | "label" | "createdAt" | "updatedAt"
> &
  OptionalNullable<
    Pick<
      MeasurementReminderBackupEntry,
      | "measurementType"
      | "intervalDays"
      | "rrule"
      | "anchorDate"
      | "endsOn"
      | "origin"
      | "notifyHour"
      | "location"
      | "nextDueAt"
      | "lastSatisfiedAt"
      | "enabled"
      | "vaccinationAntigen"
      | "snoozedUntil"
      | "lastSkippedAt"
      | "skipCount"
    >
  > & { deletedAt?: string | null };

export type RestoredMeasurementReminderEvent = Pick<
  MeasurementReminderEventBackupEntry,
  "id" | "reminderId" | "occurredAt" | "onTime" | "source" | "createdAt"
> & {
  kind: MeasurementReminderEventKind;
};

/**
 * Re-create the account's Vorsorge reminders and their completion ledger.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. The ledger is deleted before the reminders so its cleared count is
 * truthful (the cascade would empty it anyway, silently), and recreated after
 * them, because a ledger row addresses its reminder by id.
 *
 * MUST be called BEFORE the encounters and the vaccination records are
 * restored: both carry a `reminderId` that they remap against the reminders
 * in the database, and calling this later would make every one of those
 * references read as unresolvable and be dropped — a restore counted as
 * successful while it quietly disconnected every booster and appointment.
 */
export async function restoreRemindersData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: RemindersRestoreInput,
  skips: RestoreSkipLog,
): Promise<RemindersRestoreCleared> {
  const clearedEvents = await tx.measurementReminderEvent.deleteMany({
    where: { userId: ownerId },
  });
  const clearedReminders = await tx.measurementReminder.deleteMany({
    where: { userId: ownerId },
  });

  if (payload.measurementReminders.length > 0) {
    await tx.measurementReminder.createMany({
      data: payload.measurementReminders.map((entry) => ({
        id: entry.id,
        userId: ownerId,
        label: entry.label,
        measurementType: entry.measurementType ?? null,
        intervalDays: entry.intervalDays ?? null,
        rrule: entry.rrule ?? null,
        anchorDate: entry.anchorDate ? new Date(entry.anchorDate) : null,
        endsOn: entry.endsOn ? new Date(entry.endsOn) : null,
        // A file written before a column existed says nothing about it, and
        // the schema default is what those rows were living as.
        origin: entry.origin ?? "VORSORGE",
        notifyHour: entry.notifyHour ?? 9,
        location: entry.location ?? null,
        // Verbatim, not recomputed: `nextDueAt` is server-authoritative and
        // the exported value IS what the server had resolved. Recomputing
        // here would move a due date the person had already been shown.
        nextDueAt: entry.nextDueAt ? new Date(entry.nextDueAt) : null,
        lastSatisfiedAt: entry.lastSatisfiedAt
          ? new Date(entry.lastSatisfiedAt)
          : null,
        enabled: entry.enabled ?? true,
        vaccinationAntigen: entry.vaccinationAntigen ?? null,
        snoozedUntil: entry.snoozedUntil ? new Date(entry.snoozedUntil) : null,
        lastSkippedAt: entry.lastSkippedAt
          ? new Date(entry.lastSkippedAt)
          : null,
        skipCount: entry.skipCount ?? 0,
        createdAt: new Date(entry.createdAt),
        updatedAt: new Date(entry.updatedAt),
        deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
      })),
    });
  }

  // The builder filters the ledger to carried reminders, so a file this
  // release writes never drops here. A file that does reference a reminder it
  // does not carry cannot have that row invented, and a dangling id would
  // fail the foreign key and roll the whole restore back over one ledger
  // line. The row is dropped and reported instead.
  const restoredReminders = new Set(
    payload.measurementReminders.map((entry) => entry.id),
  );
  const writableEvents: RestoredMeasurementReminderEvent[] = [];
  const droppedReminderRefs: string[] = [];
  for (const entry of payload.measurementReminderEvents) {
    if (restoredReminders.has(entry.reminderId)) {
      writableEvents.push(entry);
    } else {
      droppedReminderRefs.push(entry.reminderId);
    }
  }
  if (writableEvents.length > 0) {
    await tx.measurementReminderEvent.createMany({
      data: writableEvents.map((entry) => ({
        id: entry.id,
        userId: ownerId,
        reminderId: entry.reminderId,
        kind: entry.kind,
        occurredAt: new Date(entry.occurredAt),
        onTime: entry.onTime,
        source: entry.source,
        createdAt: new Date(entry.createdAt),
      })),
    });
  }
  recordUnknownKeys(
    skips,
    "reminderReference",
    [...new Set(droppedReminderRefs)],
    droppedReminderRefs,
  );

  return {
    measurementReminders: clearedReminders.count,
    measurementReminderEvents: clearedEvents.count,
  };
}
