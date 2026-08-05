/**
 * v1.18.6 — explicit "complete" for a Vorsorge reminder (iOS #23 follow-up).
 *
 * The user-action equivalent of the cron auto-satisfy: the iOS app (and web)
 * call this when the user actively marks a measurement reminder done, rather
 * than only dismissing the notification locally. It routes through the ONE
 * shared `satisfyReminder` primitive — the same code the cron auto-resolve
 * and the eventful ingest worker use — so it:
 *
 *   - stamps `lastSatisfiedAt = now` and re-anchors the server-authoritative
 *     `nextDueAt` past now (one engine, no duplicated reschedule logic);
 *   - fires NO notification of its own (the primitive only writes the row;
 *     the dispatcher is never invoked on this path);
 *   - is idempotent via the primitive's forward-only guard — completing an
 *     already-completed / auto-satisfied reminder is a no-op that still
 *     returns 200, with `completed: false` so the client can tell the second
 *     tap apart from the first.
 *
 * Distinct from `satisfy` only in that the response surfaces the `completed`
 * flag the explicit-action flow benefits from; the underlying effect is the
 * shared satisfaction primitive either way.
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
    // v1.37.0 — MANAGE. Marking a reminder satisfied re-anchors a schedule the level
    // already admits arming and editing.
    const { user } = await requireRecordAuth("manage", "measurements");
    const { id } = await params;

    const existing = await prisma.measurementReminder.findFirst({
      where: { id, deletedAt: null },
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
    // Forward-only: a completion strictly after any prior satisfy advances
    // the row; a completion at/behind the last satisfy is a no-op. Either
    // way no notification is emitted — the primitive only stamps + reschedules.
    const result = await satisfyReminder(prisma, existing, timezone, now);

    const updated = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id },
    });

    await auditLog("measurementReminder.complete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reminderId: id, completed: result.satisfied },
    });

    annotate({
      action: { name: "measurement-reminders.complete" },
      meta: { reminderId: id, completed: result.satisfied },
    });

    return apiSuccess({
      completed: result.satisfied,
      reminder: toMeasurementReminderDto(updated),
    });
  },
);
