/**
 * `GET    /api/practitioners/{id}` — one owned, live practitioner.
 * `PATCH  /api/practitioners/{id}` — edit it (partial; field-by-field).
 * `DELETE /api/practitioners/{id}` — soft-delete it (idempotent).
 *
 * Owner-scoped by fetch-then-guard, the episode-detail pattern: the row is
 * read by id and then checked against the resolved user, so a foreign id and a
 * missing id give the same 404 and probing learns nothing.
 *
 * Deleting a practitioner keeps every visit that named it. The foreign key is
 * SetNull, so the visits survive with no practice attached rather than
 * disappearing with the address-book entry.
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
import { practitionerUpdateSchema } from "@/lib/validations/practitioners";
import { toPractitionerDTO } from "@/lib/practitioners/dto";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "profile");

    const { id } = await params;
    const row = await prisma.practitioner.findUnique({ where: { id } });
    if (!row || row.userId !== user.id || row.deletedAt !== null) {
      return apiError("Practitioner not found", 404);
    }

    annotate({
      action: {
        name: "practitioner.contact.read",
        entity_type: "practitioner",
        entity_id: id,
      },
    });

    return apiSuccess(toPractitionerDTO(row));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.practitioner.findUnique({ where: { id } });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return apiError("Practitioner not found", 404);
    }

    const { data: rawBody, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = practitionerUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "practitioner.invalid",
      });
    }

    const entry = parsed.data;

    // Field-by-field, and only the keys the body actually named: an absent key
    // leaves the column alone, an explicit null clears it.
    const data: Prisma.PractitionerUpdateInput = {};
    if (entry.name !== undefined) data.name = entry.name;
    if (entry.specialty !== undefined) data.specialty = entry.specialty;
    if (entry.practice !== undefined) data.practice = entry.practice;
    if (entry.location !== undefined) data.location = entry.location;
    if (entry.phone !== undefined) data.phone = entry.phone;
    if (entry.note !== undefined) {
      data.noteEncrypted = entry.note ? encryptToBytes(entry.note) : null;
    }

    const updated = await prisma.practitioner.update({ where: { id }, data });

    await auditLog("practitioner.contact.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        practitionerId: id,
        // A manager may edit somebody else's address book, so the owner's
        // activity feed has to say what changed rather than only that
        // something did. The note is deliberately absent: it is encrypted PHI
        // and the audit table is not a second copy of the record.
        ...overwriteDetails({
          before: {
            name: existing.name,
            specialty: existing.specialty,
            practice: existing.practice,
            location: existing.location,
            phone: existing.phone,
          },
          after: {
            name: updated.name,
            specialty: updated.specialty,
            practice: updated.practice,
            location: updated.location,
            phone: updated.phone,
          },
        }),
      },
    });

    annotate({
      action: {
        name: "practitioner.contact.update",
        entity_type: "practitioner",
        entity_id: id,
      },
    });

    return apiSuccess(toPractitionerDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.practitioner.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Practitioner not found", 404);
    }
    // Already tombstoned: deleting twice is a no-op that still succeeds.
    if (existing.deletedAt === null) {
      await prisma.practitioner.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    }

    await auditLog("practitioner.contact.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // Soft delete: the row and its name survive, so the id is enough to
      // reconstruct what went missing from the list.
      details: { practitionerId: id, name: existing.name },
    });

    annotate({
      action: {
        name: "practitioner.contact.delete",
        entity_type: "practitioner",
        entity_id: id,
      },
    });

    return apiSuccess({ deleted: true });
  },
);
