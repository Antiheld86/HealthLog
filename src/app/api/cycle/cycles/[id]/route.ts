/**
 * `DELETE /api/cycle/cycles/{id}` — soft-delete a cycle
 * (ios-contract §2.F): set `deletedAt` + bump `syncVersion`, emit a
 * tombstone on the next sync page. 204. Idempotent. Owner-scoped + gated.
 *
 * The delete also hands the span back to the preceding cycle. Opening a cycle
 * closes the one before it, so removing it without re-deriving that boundary
 * left the previous cycle standing as a closed torso with an end date taken
 * from a cycle that no longer exists — and a record whose last cycle is closed
 * has no open cycle to forecast from.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { apiError, getClientIp } from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { reanchorAfterRemovedStart } from "@/lib/cycle/cycle-boundaries";

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
      select: { id: true, userId: true, startDate: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Cycle not found", 404);
    }

    // Tombstone + re-anchor as one unit: a neighbour re-derived against a
    // half-applied delete would read the row being removed as still live.
    const reanchored = await prisma.$transaction(async (db) => {
      await db.menstrualCycle.update({
        where: { id },
        data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
      });
      return reanchorAfterRemovedStart(db, user.id, existing.startDate);
    });

    await auditLog("cycle.cycle.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // The tombstone carries the deleted cycle's own columns, so the only
      // unrecoverable part of this write is what it moved on the NEIGHBOUR.
      details: {
        cycleId: id,
        startDate: existing.startDate,
        ...(reanchored
          ? {
              reanchoredCycleId: reanchored.cycleId,
              ...overwriteDetails({
                before: {
                  endDate: reanchored.endDateBefore,
                  lengthDays: reanchored.lengthDaysBefore,
                },
                after: {
                  endDate: reanchored.endDateAfter,
                  lengthDays: reanchored.lengthDaysAfter,
                },
              }),
            }
          : {}),
      },
    });

    annotate({
      action: {
        name: "cycle.cycle.delete",
        entity_type: "menstrual_cycle",
        entity_id: id,
      },
      meta: { reanchored_prior: reanchored !== null },
    });

    return new Response(null, { status: 204 });
  },
);
