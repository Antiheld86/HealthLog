/**
 * The work the encounter routes share: resolving a visit, wiring its links,
 * and keeping its appointment reminder in step with its status.
 *
 * Lives beside the routes rather than inside one of them because create and
 * edit both do most of it, and a copy in each is how the two drift.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import {
  satisfyReminder,
  type SatisfiableReminder,
} from "@/lib/measurement-reminders/satisfy";
import { listTargets, replaceTargets, type LinkTargetKind } from "@/lib/links";
import type { EncounterLinksDTO } from "@/lib/encounters/dto";
import {
  deleteAppointmentReminder,
  disableAppointmentReminder,
  mintAppointmentReminder,
  reanchorAppointmentReminder,
  type AppointmentReminderInput,
} from "@/lib/encounters/appointment-reminder";

const DEFAULT_TIMEZONE = "Europe/Berlin";

export async function resolveTimezone(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return row?.timezone || DEFAULT_TIMEZONE;
}

/** The relations the detail and list responses resolve. */
export const ENCOUNTER_INCLUDE = {
  practitioner: true,
  reminder: { select: { nextDueAt: true } },
} as const satisfies Prisma.EncounterInclude;

/** The three link families, resolved for one visit. */
export async function loadEncounterLinks(
  tx: Prisma.TransactionClient,
  userId: string,
  encounterId: string,
): Promise<EncounterLinksDTO> {
  const read = (targetKind: LinkTargetKind) =>
    listTargets(tx, {
      userId,
      sourceKind: "encounter",
      sourceId: encounterId,
      targetKind,
    });
  const [documents, labResults, conditions] = await Promise.all([
    read("document"),
    read("labResult"),
    read("conditionEpisode"),
  ]);
  return { documents, labResults, conditions };
}

/**
 * Apply whichever of the three link arrays the request actually named.
 *
 * An absent array leaves that family alone; a present one replaces it, empty
 * array included. Unknown ids are dropped by the link service and never block
 * the save — a visit is never refused because one document it pointed at has
 * since been deleted.
 */
export async function applyEncounterLinks(
  tx: Prisma.TransactionClient,
  userId: string,
  encounterId: string,
  arrays: {
    documentIds?: string[];
    labResultIds?: string[];
    episodeIds?: string[];
  },
): Promise<void> {
  const families: Array<[LinkTargetKind, string[] | undefined]> = [
    ["document", arrays.documentIds],
    ["labResult", arrays.labResultIds],
    ["conditionEpisode", arrays.episodeIds],
  ];
  for (const [targetKind, targetIds] of families) {
    if (targetIds === undefined) continue;
    await replaceTargets(tx, {
      userId,
      sourceKind: "encounter",
      sourceId: encounterId,
      targetKind,
      targetIds,
    });
  }
}

/**
 * Whether a visit in this state, at this instant, should be nudging.
 *
 * Only a PLANNED visit in the future does. A visit that already happened needs
 * no reminder, and a terminal one must not produce a nudge for an appointment
 * that is not going to occur.
 */
export function shouldHaveReminder(
  status: string,
  occurredAt: Date,
  now: Date,
): boolean {
  return status === "PLANNED" && occurredAt.getTime() > now.getTime();
}

export interface ReminderSyncInput extends AppointmentReminderInput {
  status: string;
  /**
   * The APPOINTMENT reminder this visit already owns, or null.
   *
   * Never a checkup the visit closes. `Encounter.reminderId` carries either
   * one, and the two are kept apart by their origin: an appointment reminder
   * is `ENCOUNTER`, a checkup is not. Confusing them would re-anchor a
   * person's own Vorsorge cadence onto an appointment date, which is why the
   * routes resolve the origin before calling this.
   */
  existingReminderId: string | null;
}

/**
 * Bring the visit's appointment reminder in line with the visit.
 *
 * Returns the id to store on `Encounter.reminderId` — the existing one, a
 * freshly minted one, or the existing one left in place but switched off.
 * Never mints a second row for a visit that already has one.
 */
export async function syncAppointmentReminder(
  tx: Prisma.TransactionClient,
  input: ReminderSyncInput,
  timezone: string,
  now: Date,
): Promise<string | null> {
  const wanted = shouldHaveReminder(input.status, input.occurredAt, now);

  if (!wanted) {
    // The row stays — the history of a cancelled appointment is worth keeping —
    // but it stops nudging.
    if (input.existingReminderId) {
      await disableAppointmentReminder(tx, input.existingReminderId);
    }
    return input.existingReminderId;
  }

  if (input.existingReminderId) {
    await reanchorAppointmentReminder(
      tx,
      input.existingReminderId,
      input,
      timezone,
    );
    return input.existingReminderId;
  }

  return mintAppointmentReminder(tx, input, timezone);
}

/**
 * The checkup a visit says it closes, re-narrowed to the caller.
 *
 * Refuses an `ENCOUNTER`-origin row outright. Those belong to a booked visit
 * and are not a checkup anybody can close by filing one; accepting it here
 * would let a client re-point one visit's appointment reminder at another
 * visit and re-anchor it on the wrong date.
 *
 * Returns `undefined` when the id names nothing closeable.
 */
export async function resolveClosableReminder(
  tx: Prisma.TransactionClient,
  userId: string,
  reminderId: string,
): Promise<SatisfiableReminder | undefined> {
  const row = await tx.measurementReminder.findUnique({
    where: { id: reminderId },
    select: {
      id: true,
      userId: true,
      origin: true,
      deletedAt: true,
      intervalDays: true,
      rrule: true,
      anchorDate: true,
      notifyHour: true,
      lastSatisfiedAt: true,
      createdAt: true,
    },
  });
  if (!row || row.userId !== userId || row.deletedAt !== null) return undefined;
  if (row.origin === "ENCOUNTER") return undefined;
  return {
    id: row.id,
    intervalDays: row.intervalDays,
    rrule: row.rrule,
    anchorDate: row.anchorDate,
    notifyHour: row.notifyHour,
    lastSatisfiedAt: row.lastSatisfiedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Close the checkup a completed visit was filed against.
 *
 * `satisfyReminder` is the one shared primitive the cron, the ingest worker
 * and the explicit user action all route through, and it is forward-only and
 * idempotent — so filing the same visit as DONE twice is a no-op that still
 * succeeds. That is the whole of "the appointment closes the checkup"; there
 * is no second mechanism.
 */
export async function closeCheckupForVisit(
  tx: Prisma.TransactionClient,
  reminder: SatisfiableReminder,
  timezone: string,
  now: Date,
): Promise<void> {
  await satisfyReminder(tx as unknown as PrismaClient, reminder, timezone, now);
}

/** Soft-delete a visit's reminder alongside the visit. */
export async function retireAppointmentReminder(
  tx: Prisma.TransactionClient,
  reminderId: string | null,
  at: Date,
): Promise<void> {
  if (!reminderId) return;
  await deleteAppointmentReminder(tx, reminderId, at);
}

/**
 * The practitioner a visit names, re-narrowed to the caller.
 *
 * Returns `undefined` when the id names nothing this account owns, which the
 * routes turn into a 404 — the same refusal shape a foreign encounter id gets.
 */
export async function resolveOwnedPractitioner(
  tx: Prisma.TransactionClient,
  userId: string,
  practitionerId: string,
): Promise<{ id: string; name: string; location: string | null } | undefined> {
  const row = await tx.practitioner.findUnique({
    where: { id: practitionerId },
    select: {
      id: true,
      name: true,
      location: true,
      userId: true,
      deletedAt: true,
    },
  });
  if (!row || row.userId !== userId || row.deletedAt !== null) return undefined;
  return { id: row.id, name: row.name, location: row.location };
}
