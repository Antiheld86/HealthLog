/**
 * `GET  /api/encounters` — the account's visits, split into upcoming and past.
 * `POST /api/encounters` — file one, optionally pre-linked and optionally
 *                          booked as a future appointment.
 *
 * No module gate: a visit is core. The reasoning is written at the `Encounter`
 * model in `prisma/schema.prisma`, and the gate is relocated to the link
 * pickers, which follow the modules that own what they point at.
 *
 * `userId` is narrowed from auth and fed to the Prisma `where`; it is never a
 * body field. The `data` object is built field-by-field. Nothing is mandatory
 * except the date: a visit saves with an instant and nothing else.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  encounterCreateSchema,
  encounterListQuerySchema,
} from "@/lib/validations/encounters";
import { toEncounterDTO, type EncounterListDTO } from "@/lib/encounters/dto";
import {
  ENCOUNTER_INCLUDE,
  applyEncounterLinks,
  closeCheckupForVisit,
  resolveClosableReminder,
  resolveOwnedPractitioner,
  resolveTimezone,
  shouldHaveReminder,
  syncAppointmentReminder,
} from "@/lib/encounters/service";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = encounterListQuerySchema.safeParse({
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    status: params.get("status") ?? undefined,
    practitionerId: params.get("practitionerId") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "encounter.invalid",
    });
  }

  const query = parsed.data;
  const take = query.limit ?? 100;
  const now = new Date();

  const where = {
    userId: user.id,
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...(query.practitionerId ? { practitionerId: query.practitionerId } : {}),
    ...(query.from || query.to
      ? {
          occurredAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
  };

  // Two queries rather than one sorted list. Upcoming reads soonest-first and
  // past reads newest-first, which is the opposite direction; resolving both
  // here means the client renders two lists instead of splitting and
  // re-sorting one, and the ordering lives in one place.
  const [upcoming, past] = await Promise.all([
    prisma.encounter.findMany({
      where: { ...where, occurredAt: { ...where.occurredAt, gt: now } },
      orderBy: { occurredAt: "asc" },
      take,
      include: ENCOUNTER_INCLUDE,
    }),
    prisma.encounter.findMany({
      where: { ...where, occurredAt: { ...where.occurredAt, lte: now } },
      orderBy: { occurredAt: "desc" },
      take,
      include: ENCOUNTER_INCLUDE,
    }),
  ]);

  annotate({
    action: { name: "encounter.visit.list", entity_type: "encounter" },
    meta: { upcoming: upcoming.length, past: past.length },
  });

  const body: EncounterListDTO = {
    upcoming: upcoming.map((row) => toEncounterDTO(row)),
    past: past.map((row) => toEncounterDTO(row)),
  };
  return apiSuccess(body);
});

// A double-tap on "save" must not file the same visit twice.
export const POST = apiHandler(withIdempotency<[NextRequest]>(postEncounter));

async function postEncounter(request: NextRequest): Promise<Response> {
  const { user } = await requireRecordAuth("write", "profile");

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 32 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = encounterCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "encounter.visit.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "encounter.invalid",
    });
  }

  const entry = parsed.data;
  const occurredAt = new Date(entry.occurredAt);
  const timezone = await resolveTimezone(user.id);
  const now = new Date();

  const created = await prisma.$transaction(async (tx) => {
    // A practitioner the caller does not own is a refusal rather than a
    // silently dropped field: the person named a practice and would otherwise
    // see the visit save without it.
    let practitioner:
      { id: string; name: string; location: string | null } | undefined;
    if (entry.practitionerId) {
      practitioner = await resolveOwnedPractitioner(
        tx,
        user.id,
        entry.practitionerId,
      );
      if (!practitioner) return null;
    }

    // Field-by-field — never spread the parsed object whole.
    const row = await tx.encounter.create({
      data: {
        userId: user.id,
        occurredAt,
        status: entry.status,
        kind: entry.kind,
        practitionerId: practitioner?.id ?? null,
        reasonEncrypted: entry.reason ? encryptToBytes(entry.reason) : null,
        outcomeEncrypted: entry.outcome ? encryptToBytes(entry.outcome) : null,
      },
      select: { id: true },
    });

    await applyEncounterLinks(tx, user.id, row.id, entry);

    // `Encounter.reminderId` carries one of two things, never both, and which
    // one follows from the visit's own state. A booked appointment owns a
    // reminder this code mints; a completed visit may instead close a checkup
    // the person already had. A body claiming both is contradictory — a visit
    // that has not happened cannot have closed anything — and is refused.
    let reminderId: string | null = null;

    if (shouldHaveReminder(entry.status, occurredAt, now)) {
      if (entry.reminderId) return "contradictory-reminder" as const;
      reminderId = await syncAppointmentReminder(
        tx,
        {
          userId: user.id,
          occurredAt,
          practitionerName: practitioner?.name ?? null,
          practitionerLocation: practitioner?.location ?? null,
          kindLabel: entry.kind,
          status: entry.status,
          existingReminderId: null,
        },
        timezone,
        now,
      );
    } else if (entry.reminderId) {
      const checkup = await resolveClosableReminder(
        tx,
        user.id,
        entry.reminderId,
      );
      if (!checkup) return "unknown-reminder" as const;
      reminderId = checkup.id;
      // Filing a visit as done against a due checkup closes it. Forward-only
      // and idempotent, so re-filing the same visit changes nothing.
      if (entry.status === "DONE") {
        await closeCheckupForVisit(tx, checkup, timezone, now);
      }
    }

    if (reminderId) {
      await tx.encounter.update({
        where: { id: row.id },
        data: { reminderId },
      });
    }

    return tx.encounter.findUniqueOrThrow({
      where: { id: row.id },
      include: ENCOUNTER_INCLUDE,
    });
  });

  if (created === null) {
    return apiError("Practitioner not found", 404, {
      errorCode: "encounter.practitioner-not-found",
    });
  }
  if (created === "unknown-reminder") {
    return apiError("Checkup not found", 404, {
      errorCode: "encounter.reminder-not-found",
    });
  }
  if (created === "contradictory-reminder") {
    return apiError(
      "A planned visit cannot also close a checkup — it has not happened yet",
      422,
      { errorCode: "encounter.reminder-conflict" },
    );
  }

  await auditLog("encounter.visit.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { encounterId: created.id, status: created.status },
  });

  annotate({
    action: {
      name: "encounter.visit.create",
      entity_type: "encounter",
      entity_id: created.id,
    },
    meta: { status: created.status, kind: created.kind },
  });

  return apiSuccess(toEncounterDTO(created), 201);
}
