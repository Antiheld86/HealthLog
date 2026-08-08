/**
 * `GET    /api/encounters/{id}` — one owned, live visit with its links resolved.
 * `PATCH  /api/encounters/{id}` — edit it (partial; field-by-field).
 * `DELETE /api/encounters/{id}` — soft-delete it, and retire its appointment
 *          reminder with it.
 *
 * Owner-scoped by fetch-then-guard. `userId` is narrowed from auth; the body
 * never carries it.
 *
 * The status transitions are where the appointment arm lives. Moving a visit to
 * DONE closes the checkup it was filed against — on the transition, so re-saving
 * a completed visit does not push that checkup's next due date out again.
 * Moving it to CANCELLED or NO_SHOW stops its reminder without deleting the
 * row, so the history stays honest. Moving its date re-anchors the reminder it
 * already owns and never mints a second.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { encounterUpdateSchema } from "@/lib/validations/encounters";
import { toEncounterDTO } from "@/lib/encounters/dto";
import {
  ENCOUNTER_INCLUDE,
  applyEncounterLinks,
  closeCheckupForVisit,
  loadEncounterLinks,
  resolveClosableReminder,
  resolveOwnedPractitioner,
  resolveTimezone,
  shouldHaveReminder,
  syncAppointmentReminder,
} from "@/lib/encounters/service";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "profile");

    const { id } = await params;
    const row = await prisma.encounter.findUnique({
      where: { id },
      include: ENCOUNTER_INCLUDE,
    });
    if (!row || row.userId !== user.id || row.deletedAt !== null) {
      return apiError("Visit not found", 404);
    }

    const links = await loadEncounterLinks(prisma, user.id, id);

    annotate({
      action: {
        name: "encounter.visit.read",
        entity_type: "encounter",
        entity_id: id,
      },
    });

    return apiSuccess(toEncounterDTO(row, links));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.encounter.findUnique({ where: { id } });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return apiError("Visit not found", 404);
    }

    const { data: rawBody, error: jsonError } = await safeJson(request, {
      maxBytes: 32 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = encounterUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "encounter.invalid",
      });
    }

    const entry = parsed.data;
    const timezone = await resolveTimezone(user.id);
    const now = new Date();

    // The state the visit will be in once this edit lands. Both the reminder
    // decision and the checkup decision read from here rather than from the
    // body, so an edit that moves only the date is judged against the status
    // the visit already has.
    const nextOccurredAt = entry.occurredAt
      ? new Date(entry.occurredAt)
      : existing.occurredAt;
    const nextStatus = entry.status ?? existing.status;

    const outcome = await prisma.$transaction(async (tx) => {
      let practitionerId = existing.practitionerId;
      let practitionerName: string | null = null;
      let practitionerLocation: string | null = null;

      if (entry.practitionerId !== undefined) {
        if (entry.practitionerId === null) {
          practitionerId = null;
        } else {
          const resolved = await resolveOwnedPractitioner(
            tx,
            user.id,
            entry.practitionerId,
          );
          if (!resolved) return "unknown-practitioner" as const;
          practitionerId = resolved.id;
          practitionerName = resolved.name;
          practitionerLocation = resolved.location;
        }
      } else if (practitionerId) {
        const resolved = await resolveOwnedPractitioner(
          tx,
          user.id,
          practitionerId,
        );
        practitionerName = resolved?.name ?? null;
        practitionerLocation = resolved?.location ?? null;
      }

      const data: Prisma.EncounterUpdateInput = {};
      if (entry.occurredAt !== undefined) data.occurredAt = nextOccurredAt;
      if (entry.status !== undefined) data.status = entry.status;
      if (entry.kind !== undefined) data.kind = entry.kind;
      if (entry.reason !== undefined) {
        data.reasonEncrypted = entry.reason
          ? encryptToBytes(entry.reason)
          : null;
      }
      if (entry.outcome !== undefined) {
        data.outcomeEncrypted = entry.outcome
          ? encryptToBytes(entry.outcome)
          : null;
      }
      if (entry.practitionerId !== undefined) {
        data.practitioner = practitionerId
          ? { connect: { id: practitionerId } }
          : { disconnect: true };
      }

      // Whether the visit's own appointment reminder — the ENCOUNTER-origin
      // row this code minted — is the thing `reminderId` currently holds. A
      // checkup the visit closes lives in the same column and must not be
      // re-anchored onto the appointment's date.
      const currentReminder = existing.reminderId
        ? await tx.measurementReminder.findUnique({
            where: { id: existing.reminderId },
            select: { id: true, origin: true },
          })
        : null;
      const ownAppointmentReminderId =
        currentReminder?.origin === "ENCOUNTER" ? currentReminder.id : null;

      let reminderId = existing.reminderId;

      if (shouldHaveReminder(nextStatus, nextOccurredAt, now)) {
        reminderId = await syncAppointmentReminder(
          tx,
          {
            userId: user.id,
            occurredAt: nextOccurredAt,
            practitionerName,
            practitionerLocation,
            kindLabel: entry.kind ?? existing.kind,
            status: nextStatus,
            existingReminderId: ownAppointmentReminderId,
          },
          timezone,
          now,
        );
      } else if (ownAppointmentReminderId) {
        // No longer a future appointment: the row stays, switched off.
        reminderId = await syncAppointmentReminder(
          tx,
          {
            userId: user.id,
            occurredAt: nextOccurredAt,
            practitionerName,
            practitionerLocation,
            kindLabel: entry.kind ?? existing.kind,
            status: nextStatus,
            existingReminderId: ownAppointmentReminderId,
          },
          timezone,
          now,
        );
      }

      // A body may re-point the visit at the checkup it closes.
      if (entry.reminderId !== undefined) {
        if (entry.reminderId === null) {
          reminderId = ownAppointmentReminderId;
        } else {
          const checkup = await resolveClosableReminder(
            tx,
            user.id,
            entry.reminderId,
          );
          if (!checkup) return "unknown-reminder" as const;
          reminderId = checkup.id;
        }
      }

      if (reminderId !== existing.reminderId) {
        data.reminder = reminderId
          ? { connect: { id: reminderId } }
          : { disconnect: true };
      }

      const updated = await tx.encounter.update({ where: { id }, data });

      await applyEncounterLinks(tx, user.id, id, entry);

      // Filing the visit as done closes the checkup it names — on the
      // TRANSITION, not on every edit of a visit that is already done.
      //
      // `satisfyReminder` is forward-only, which means an older instant is a
      // no-op and a NEWER one always advances. So re-saving a completed visit
      // would push the checkup's next due date out again, as if the person had
      // been a second time. Gating on the transition is what makes re-filing
      // genuinely idempotent rather than merely non-erroring.
      const closesCheckupNow =
        nextStatus === "DONE" && existing.status !== "DONE";
      if (closesCheckupNow && reminderId) {
        const checkup = await resolveClosableReminder(tx, user.id, reminderId);
        if (checkup) await closeCheckupForVisit(tx, checkup, timezone, now);
      }

      return { updated };
    });

    if (outcome === "unknown-practitioner") {
      return apiError("Practitioner not found", 404, {
        errorCode: "encounter.practitioner-not-found",
      });
    }
    if (outcome === "unknown-reminder") {
      return apiError("Checkup not found", 404, {
        errorCode: "encounter.reminder-not-found",
      });
    }

    const row = await prisma.encounter.findUniqueOrThrow({
      where: { id },
      include: ENCOUNTER_INCLUDE,
    });
    const links = await loadEncounterLinks(prisma, user.id, id);

    await auditLog("encounter.visit.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        encounterId: id,
        // The free text is deliberately absent: it is encrypted PHI and the
        // audit table is not a second copy of the record.
        ...overwriteDetails({
          before: {
            occurredAt: existing.occurredAt,
            status: existing.status,
            kind: existing.kind,
            practitionerId: existing.practitionerId,
          },
          after: {
            occurredAt: outcome.updated.occurredAt,
            status: outcome.updated.status,
            kind: outcome.updated.kind,
            practitionerId: outcome.updated.practitionerId,
          },
        }),
      },
    });

    annotate({
      action: {
        name: "encounter.visit.update",
        entity_type: "encounter",
        entity_id: id,
      },
      meta: { status: row.status },
    });

    return apiSuccess(toEncounterDTO(row, links));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.encounter.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Visit not found", 404);
    }

    // Already tombstoned: deleting twice is a no-op that still succeeds.
    if (existing.deletedAt === null) {
      const at = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.encounter.update({ where: { id }, data: { deletedAt: at } });
        // Only the visit's OWN appointment reminder goes with it. A checkup the
        // visit closed belongs to the person's Vorsorge list and outlives it.
        if (existing.reminderId) {
          const reminder = await tx.measurementReminder.findUnique({
            where: { id: existing.reminderId },
            select: { id: true, origin: true },
          });
          if (reminder?.origin === "ENCOUNTER") {
            await tx.measurementReminder.update({
              where: { id: reminder.id },
              data: { deletedAt: at, enabled: false, nextDueAt: null },
            });
          }
        }
      });
    }

    await auditLog("encounter.visit.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        encounterId: id,
        occurredAt: existing.occurredAt.toISOString(),
        status: existing.status,
      },
    });

    annotate({
      action: {
        name: "encounter.visit.delete",
        entity_type: "encounter",
        entity_id: id,
      },
    });

    return apiSuccess({ deleted: true });
  },
);
