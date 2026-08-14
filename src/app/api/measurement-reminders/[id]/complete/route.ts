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
import { isScreeningReminderType } from "@/lib/validations/measurement-reminders";

type RouteParams = { params: Promise<{ id: string }> };

const DEFAULT_TIMEZONE = "Europe/Berlin";

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Marking a reminder satisfied re-anchors a schedule the level
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

    // Defense-in-depth: a screening reminder (PHQ-9 / GAD-7 / WHO-5 / SCI)
    // resolves ONLY from the server-written *_SCORE row a completed check-in
    // produces — never from a manual "complete." The client routes a screening
    // to `/mental-wellbeing` instead of offering this action, so a completion
    // landing here is a crafted request; refusing it keeps a screening from
    // reading as completed with no assessment behind it.
    if (isScreeningReminderType(existing.measurementType)) {
      return apiError(
        "Screening reminders resolve from a completed check-in, not a manual completion",
        409,
      );
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
    const result = await satisfyReminder(
      prisma,
      existing,
      timezone,
      now,
      "manual",
    );

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
