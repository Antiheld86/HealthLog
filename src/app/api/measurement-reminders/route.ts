/**
 * v1.17.1 — Vorsorge (measurement) reminders CRUD: list + create.
 *
 * Server-authoritative `nextDueAt` is computed via the canonical
 * medication recurrence engine so web ↔ iOS read identical numbers.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";
import { createMeasurementReminderSchema } from "@/lib/validations/measurement-reminders";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";

const DEFAULT_TIMEZONE = "Europe/Berlin";

async function resolveTimezone(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return row?.timezone || DEFAULT_TIMEZONE;
}

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "measurements");

  const reminders = await prisma.measurementReminder.findMany({
    where: { userId: user.id, deletedAt: null },
    // Most-urgent first; a null next-due (uncomputable / disabled) sinks
    // to the end so the actionable items float to the top.
    orderBy: [
      { nextDueAt: { sort: "asc", nulls: "last" } },
      { createdAt: "asc" },
    ],
  });

  annotate({
    action: { name: "measurement-reminders.list" },
    meta: { total: reminders.length },
  });

  return apiSuccess(reminders.map(toMeasurementReminderDto));
});

async function postReminder(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE. A reminder armed by a manager rings the record's own
  // phone, which is the person the reminder is about, and it is additive: the
  // row is listed, editable and removable by the owner.
  const { user } = await requireRecordAuth("manage", "measurements");

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createMeasurementReminderSchema.safeParse(body);
  if (!parsed.success) {
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "measurement-reminders.create.validation-failed" },
      meta: { issue_count: issues.length },
    });
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
    // .create`, because that helper is the only writer that stamps
    // `actorUserId`. Filed under the resolved record either way; without the
    // stamp a manager's malformed payload would read as the owner's own.
    void auditLog("measurement-reminders.create.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const data = parsed.data;

  const timezone = await resolveTimezone(user.id);
  const now = new Date();
  const anchorDate = data.anchorDate != null ? new Date(data.anchorDate) : null;

  // Server-authoritative next-due. No satisfy yet → anchors on
  // anchorDate ?? createdAt (createdAt ≈ now for a fresh row).
  const scheduleInput: ReminderScheduleInput = {
    intervalDays: data.intervalDays ?? null,
    rrule: data.rrule ?? null,
    anchorDate,
    notifyHour: data.notifyHour,
    lastSatisfiedAt: null,
    createdAt: now,
  };
  const nextDueAt = computeReminderNextDueAt(scheduleInput, timezone, now);

  // Field-by-field — no mass assignment.
  const created = await prisma.measurementReminder.create({
    data: {
      userId: user.id,
      label: data.label,
      measurementType: data.measurementType ?? null,
      intervalDays: data.intervalDays ?? null,
      rrule: data.rrule ?? null,
      anchorDate,
      notifyHour: data.notifyHour,
      location: data.location ?? null,
      enabled: data.enabled,
      nextDueAt,
    },
  });

  await auditLog("measurementReminder.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { reminderId: created.id },
  });

  annotate({
    action: { name: "measurement-reminders.create" },
    meta: { reminderId: created.id, hasType: data.measurementType != null },
  });

  return apiSuccess(toMeasurementReminderDto(created), 201);
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postReminder));
