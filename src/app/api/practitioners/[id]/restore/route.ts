/**
 * `POST /api/practitioners/{id}/restore` — clear a practitioner's tombstone.
 *
 * MANAGE rather than WRITE: undoing a deletion is a management act when the
 * manager is the one who holds delete.
 *
 * Restoring the address-book entry does NOT re-attach it to the visits that
 * named it. Those references were nulled when the row was deleted, and
 * inventing them back would be guessing at which visits meant this practice.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { toPractitionerDTO } from "@/lib/practitioners/dto";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.practitioner.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Practitioner not found", 404);
    }

    // Restoring a live row is a no-op that still succeeds, so a retry after a
    // dropped response does not answer 404 for work that already happened.
    const restored =
      existing.deletedAt === null
        ? existing
        : await prisma.practitioner.update({
            where: { id },
            data: { deletedAt: null },
          });

    await auditLog("practitioner.contact.restore", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { practitionerId: id, name: restored.name },
    });

    annotate({
      action: {
        name: "practitioner.contact.restore",
        entity_type: "practitioner",
        entity_id: id,
      },
    });

    return apiSuccess(toPractitionerDTO(restored));
  },
);
