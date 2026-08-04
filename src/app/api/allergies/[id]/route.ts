/**
 * `GET    /api/allergies/{id}` — one owned, live allergy record.
 * `PATCH  /api/allergies/{id}` — edit it (partial; field-by-field).
 * `DELETE /api/allergies/{id}` — delete it outright (`{ deleted: true }`; 404
 *   once it is gone). The confirmation dialog promises it cannot be undone, and
 *   nothing here needs a tombstone to keep that promise honest.
 *
 * Owner-scoped. `userId` is narrowed from auth and fed to the Prisma `where`;
 * the body never carries it. The free-text `reaction` + `note` are encrypted
 * at rest.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { allergyUpdateSchema } from "@/lib/validations/allergy";
import { toAllergyDTO } from "@/lib/records/dto";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "profile");

    const { id } = await params;
    const row = await prisma.allergy.findUnique({ where: { id } });
    if (!row || row.userId !== user.id || row.deletedAt !== null) {
      return apiError("Allergy not found", 404);
    }

    annotate({
      action: { name: "allergy.read", entity_type: "allergy", entity_id: id },
    });

    return apiSuccess(toAllergyDTO(row));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const existing = await prisma.allergy.findUnique({
      where: { id },
      select: { id: true, userId: true, deletedAt: true },
    });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return apiError("Allergy not found", 404);
    }

    const { data: rawBody, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = allergyUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "allergy.invalid",
      });
    }
    const entry = parsed.data;

    // Field-by-field — only fields actually present in the body are written.
    const data: Prisma.AllergyUpdateInput = {};
    if (entry.substance !== undefined) data.substance = entry.substance;
    if (entry.category !== undefined) data.category = entry.category;
    if (entry.type !== undefined) data.type = entry.type;
    if (entry.severity !== undefined) data.severity = entry.severity;
    if (entry.status !== undefined) data.status = entry.status;
    if (entry.onsetAt !== undefined) {
      data.onsetAt = entry.onsetAt ? new Date(entry.onsetAt) : null;
    }
    if (entry.reaction !== undefined) {
      data.reactionEncrypted = entry.reaction
        ? encryptToBytes(entry.reaction)
        : null;
    }
    if (entry.note !== undefined) {
      data.notesEncrypted = entry.note ? encryptToBytes(entry.note) : null;
    }

    const updated = await prisma.allergy.update({ where: { id }, data });

    await auditLog("allergy.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { allergyId: id },
    });

    annotate({
      action: { name: "allergy.update", entity_type: "allergy", entity_id: id },
    });

    return apiSuccess(toAllergyDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const existing = await prisma.allergy.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Allergy not found", 404);
    }

    // Hard delete. The confirmation says it can't be undone, and nothing here
    // needs a tombstone: no restore route reaches an allergy, no other table
    // references one, it is absent from the `/api/sync/changes` delta feed,
    // and every read already filters `deletedAt: null`. A row already carrying
    // a tombstone from before this changed is removed too, so the record
    // converges on what the dialog promised.
    await prisma.allergy.delete({ where: { id } });

    await auditLog("allergy.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { allergyId: id },
    });

    annotate({
      action: { name: "allergy.delete", entity_type: "allergy", entity_id: id },
    });

    return apiSuccess({ deleted: true });
  },
);
