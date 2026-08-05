/**
 * `DELETE /api/cycle/cycles/{id}` — soft-delete a cycle
 * (ios-contract §2.F): set `deletedAt` + bump `syncVersion`, emit a
 * tombstone on the next sync page. 204. Idempotent. Owner-scoped + gated.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";

type RouteParams = { params: Promise<{ id: string }> };

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Soft, audited, and it emits a sync tombstone, so the
    // cycle is reconstructable from its own row. The whole-domain eraser
    // (`DELETE /api/cycle/all`) stays the owner's at every level.
    const { user } = await requireRecordAuth("manage", "cycle");

    const gate = await requireCycleEnabled(user.id, user.gender);
    if (!gate.enabled) return gate.response;

    const { id } = await params;

    const existing = await prisma.menstrualCycle.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Cycle not found", 404);
    }

    await prisma.menstrualCycle.update({
      where: { id },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });

    await auditLog("cycle.cycle.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { cycleId: id },
    });

    annotate({
      action: {
        name: "cycle.cycle.delete",
        entity_type: "menstrual_cycle",
        entity_id: id,
      },
    });

    return new Response(null, { status: 204 });
  },
);
