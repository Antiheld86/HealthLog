/**
 * v1.17.1 — manual "Erledigt" for a Vorsorge reminder.
 *
 * Stamps `lastSatisfiedAt = now` and recomputes the server-authoritative
 * `nextDueAt` past now. Free-text (no measurementType) reminders resolve
 * ONLY through this path; typed reminders auto-resolve in the cron when a
 * matching reading lands, but a manual satisfy still works for them.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { satisfyReminder } from "@/lib/measurement-reminders/satisfy";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";

type RouteParams = { params: Promise<{ id: string }> };

const DEFAULT_TIMEZONE = "Europe/Berlin";

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. The same primitive from the checklist side re-anchors a schedule the level
    // already admits arming and editing.
    const { user } = await requireRecordAuth("manage", "measurements");
    const { id } = await params;

    // An appointment reminder is not addressable here. It belongs to a visit,
    // is managed through the visit routes, and sits in a different sharing
    // domain — so this family treats one as not found rather than acting on
    // it. Filtering in the lookup rather than after it is what keeps a write
    // from committing before the refusal.
    const existing = await prisma.measurementReminder.findFirst({
      where: { id, deletedAt: null, origin: { not: "ENCOUNTER" } },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement reminder not found", 404);
    }

    const userRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { timezone: true },
    });
    const timezone = userRow?.timezone || DEFAULT_TIMEZONE;

    const now = new Date();
    // The ONE shared satisfaction primitive — same code the cron
    // auto-resolve and the eventful worker use. A manual "Erledigt" is
    // always strictly after any prior satisfy, so the forward-only guard
    // advances it.
    await satisfyReminder(prisma, existing, timezone, now);

    const updated = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id },
    });

    await auditLog("measurementReminder.satisfy", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reminderId: id },
    });

    annotate({
      action: { name: "measurement-reminders.satisfy" },
      meta: { reminderId: id },
    });

    return apiSuccess(toMeasurementReminderDto(updated));
  },
);
