/**
 * v1.37.20 (#223) — honestly skip a Vorsorge reminder's current due cycle.
 *
 * No body: the skip instant is always the server clock. The interval
 * restarts from the skip (rolling: skip + N days at the notify hour; rrule:
 * next occurrence strictly after the skip), `lastSkippedAt` is stamped,
 * `skipCount` incremented, any snooze cleared, and one SKIPPED row lands in
 * the completion ledger. `lastSatisfiedAt` is NEVER touched — a skip is the
 * honest alternative to deleting or ignoring a reminder, not a completion.
 *
 * Screening reminders (PHQ-9 / GAD-7 / WHO-5 / SCI) ARE skippable — the
 * satisfy-side 409 guards against CLAIMED fulfilment without an assessment;
 * a skip claims the opposite, so refusing it here would only push people
 * back to deleting the reminder.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { skipReminder } from "@/lib/measurement-reminders/satisfy";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";

type RouteParams = { params: Promise<{ id: string }> };

const DEFAULT_TIMEZONE = "Europe/Berlin";

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // MANAGE — the same level as satisfy/complete: deciding to let a cycle
    // go re-anchors a schedule this level already admits editing.
    const { user } = await requireRecordAuth("manage", "measurements");
    const { id } = await params;

    // An appointment reminder is not addressable here. It belongs to a visit,
    // is managed through the visit routes, and sits in a different sharing
    // domain — so this family treats one as not found rather than acting on
    // it. Skipping an appointment would move a date the visit record still
    // believes it owns.
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

    const result = await skipReminder(prisma, existing, timezone, new Date());

    const updated = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id },
    });

    await auditLog("measurementReminder.skip", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reminderId: id, skipped: result.skipped },
    });

    annotate({
      action: { name: "measurement-reminders.skip" },
      meta: { reminderId: id, skipped: result.skipped },
    });

    return apiSuccess({
      skipped: result.skipped,
      reminder: toMeasurementReminderDto(updated),
    });
  },
);
