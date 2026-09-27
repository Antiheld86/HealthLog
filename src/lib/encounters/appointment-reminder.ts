/**
 * A booked visit's reminder — one row on the EXISTING engine, not a second one.
 *
 * A planned encounter mints exactly one `MeasurementReminder` with
 * `origin = ENCOUNTER`. No new queue, no new cron, no new notification event
 * type, no new preference key: the enum's own docblock states the rule, and an
 * appointment is a reminder with a date like every other reminder with a date.
 *
 * ── Why the row is shaped the way it is ─────────────────────────────────────
 *
 * `measurementType` is NULL, which is the engine's free-text arm: there is no
 * measurement that could satisfy "you have an appointment", so it resolves only
 * on an explicit satisfy. `intervalDays` and `rrule` are both NULL, which the
 * schema documents as a one-shot anchored on `anchorDate`.
 *
 * That last part carries a consequence worth stating rather than discovering:
 * `computeReminderNextDueAt` returns NULL when there is no cadence, so a
 * one-shot's first `nextDueAt` cannot come from it and is stamped here
 * directly. The same fact is what makes the never-nag property STRUCTURAL —
 * after the cron fires the row it calls that function to advance the slot, gets
 * NULL, and the reminder can never fire again. There is no guard enforcing
 * this and there should not be one; it is a property of having no cadence.
 *
 * ── One row per visit, ever ─────────────────────────────────────────────────
 *
 * Rescheduling re-anchors the existing row. It never mints a second, which is
 * why `Encounter.reminderId` is a single column and not a list. Deliberately NO
 * partial unique index enforces this: the COACH one is `WHERE origin = 'COACH'`
 * so ENCOUNTER rows do not inherit it, and a similar index here would break
 * anyone who books two appointments.
 *
 * ── The practice address is read, not copied ────────────────────────────────
 *
 * The practitioner's address is encrypted at rest (`locationEncrypted`), so
 * the reminder row carries no copy of it: `MeasurementReminder.location` stays
 * NULL on every ENCOUNTER row, and a re-anchor clears a copy an earlier release
 * wrote. The tick resolves the address from the visit's practitioner when it
 * builds the push ({@link appointmentReminderAddress}), which also means an
 * edit of the address reaches a nudge that is already booked.
 */
import type { Prisma } from "@/generated/prisma/client";
import { readPractitionerContact } from "@/lib/practitioners/dto";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";

/** What the reminder needs to know about the visit that owns it. */
export interface AppointmentReminderInput {
  userId: string;
  occurredAt: Date;
  /** Used as the label when present; the kind label is the fallback. */
  practitionerName: string | null;
  /** The fallback label when the visit names no practice. */
  kindLabel: string;
}

/** The local hour the nudge fires, read off the appointment in the user's zone. */
export function appointmentNotifyHour(
  occurredAt: Date,
  timezone: string,
): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
  }).format(occurredAt);
  const parsed = Number.parseInt(hour, 10);
  // `24` is a legal formatter output for midnight in some locales; the column
  // is 0–23 and midnight is 0.
  if (!Number.isFinite(parsed)) return 9;
  return parsed % 24;
}

function reminderLabel(input: AppointmentReminderInput): string {
  return input.practitionerName?.trim() || input.kindLabel;
}

/**
 * Mint the one reminder a planned visit owns, inside the caller's transaction.
 *
 * Returns the row's id for `Encounter.reminderId`.
 */
export async function mintAppointmentReminder(
  tx: Prisma.TransactionClient,
  input: AppointmentReminderInput,
  timezone: string,
): Promise<string> {
  const created = await tx.measurementReminder.create({
    data: {
      userId: input.userId,
      label: reminderLabel(input),
      // The free-text arm: nothing a person could measure satisfies this.
      measurementType: null,
      // Both NULL — a one-shot anchored on `anchorDate`.
      intervalDays: null,
      rrule: null,
      anchorDate: input.occurredAt,
      origin: "ENCOUNTER",
      notifyHour: appointmentNotifyHour(input.occurredAt, timezone),
      // Stamped directly: see the note at the top of this file on why the
      // cadence helper cannot produce a one-shot's first slot.
      nextDueAt: input.occurredAt,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Move an existing appointment reminder to a new instant.
 *
 * Re-anchors and re-stamps the same row rather than minting a second, and
 * re-enables it: a visit that was cancelled and then rebooked should nudge
 * again, which is the whole reason the person moved the date.
 */
export async function reanchorAppointmentReminder(
  tx: Prisma.TransactionClient,
  reminderId: string,
  input: AppointmentReminderInput,
  timezone: string,
): Promise<void> {
  await tx.measurementReminder.update({
    where: { id: reminderId },
    data: {
      label: reminderLabel(input),
      anchorDate: input.occurredAt,
      notifyHour: appointmentNotifyHour(input.occurredAt, timezone),
      // No readable copy of the address; clears one an earlier release wrote.
      location: null,
      nextDueAt: input.occurredAt,
      enabled: true,
      deletedAt: null,
    },
  });
}

/**
 * Stop an appointment reminder without deleting it.
 *
 * A cancelled or missed appointment keeps its row so the history stays honest,
 * but must never nudge again. `enabled: false` is the engine's own master
 * switch and is distinct from the tombstone.
 */
export async function disableAppointmentReminder(
  tx: Prisma.TransactionClient,
  reminderId: string,
): Promise<void> {
  await tx.measurementReminder.update({
    where: { id: reminderId },
    data: { enabled: false, nextDueAt: null },
  });
}

/** Soft-delete the reminder alongside the visit that owns it. */
export async function deleteAppointmentReminder(
  tx: Prisma.TransactionClient,
  reminderId: string,
  at: Date,
): Promise<void> {
  await tx.measurementReminder.update({
    where: { id: reminderId },
    data: { deletedAt: at, enabled: false, nextDueAt: null },
  });
}

/**
 * What a one-shot appointment reminder's next slot becomes once it has fired.
 *
 * Exported for `__tests__/appointment-reminder.test.ts`, which proves the
 * never-nag property rather than asserting it in prose: the answer must be
 * NULL, and it must come from the same function the cron uses to advance a
 * reminder it has just fired.
 */
export function appointmentNextDueAfterFiring(
  reminder: Pick<
    ReminderScheduleInput,
    "intervalDays" | "rrule" | "anchorDate" | "notifyHour" | "createdAt"
  >,
  timezone: string,
  now: Date,
): Date | null {
  return computeReminderNextDueAt(
    { ...reminder, lastSatisfiedAt: null },
    timezone,
    now,
  );
}

/**
 * What the reminder tick reads beside an ENCOUNTER row to name the practice
 * address: the practitioner of the live visit that owns it.
 */
export const APPOINTMENT_REMINDER_ADDRESS_INCLUDE = {
  encounters: {
    where: { deletedAt: null },
    select: {
      userId: true,
      practitioner: {
        select: {
          userId: true,
          deletedAt: true,
          location: true,
          locationEncrypted: true,
        },
      },
    },
    take: 1,
  },
} as const;

/**
 * The address a reminder's push names. A checkup's own free-text `location`;
 * for an appointment, the owning visit's practitioner address, decrypted
 * here. Null when the visit names no live practitioner of the same account.
 */
export function appointmentReminderAddress(reminder: {
  userId: string;
  origin: string;
  location: string | null;
  encounters?: ReadonlyArray<{
    userId: string;
    practitioner: {
      userId: string;
      deletedAt: Date | null;
      location: string | null;
      locationEncrypted: Uint8Array | null;
    } | null;
  }>;
}): string | null {
  if (reminder.origin !== "ENCOUNTER") return reminder.location;
  const visit = reminder.encounters?.[0];
  const practitioner = visit?.practitioner;
  if (
    !visit ||
    !practitioner ||
    visit.userId !== reminder.userId ||
    practitioner.userId !== reminder.userId ||
    practitioner.deletedAt !== null
  ) {
    return null;
  }
  return readPractitionerContact(
    practitioner.locationEncrypted,
    practitioner.location,
    "location",
  );
}
