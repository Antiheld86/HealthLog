/**
 * v1.22 (B2/B6/F6) — request schemas for the Coach episodic-reminder surface
 * (`/api/coach/reminders` + `/[id]`) and the generalised confirm-card endpoint
 * (`/api/coach/suggested-actions`).
 *
 * Lives outside the route files so the OpenAPI registry can import it without
 * touching the route modules (route files may only export handlers + config).
 *
 * No `userId` field anywhere — the owner is always narrowed from the session.
 * The note free-text is the only user-writable content; everything timing is
 * resolved SERVER-side from a closed grammar / catalog, so a client can never
 * mint an arbitrary schedule.
 */
import { z } from "zod/v4";

import {
  COACH_REMINDER_STATUSES,
  REMINDER_NOTE_MAX_CHARS,
  REMINDER_METRIC_MAX_CHARS,
} from "@/lib/ai/coach/reminders";
import {
  CHECKUP_LABEL_MAX_CHARS,
  ACTION_NOTE_MAX_CHARS,
  ACTION_METRIC_MAX_CHARS,
} from "@/lib/ai/coach/suggest-action";

/** A `when` grammar token: ISO date | relative +Nd/+Nw | a context cue. */
const whenToken = z.string().trim().min(1).max(32);
const metricToken = z
  .string()
  .trim()
  .min(1)
  .max(REMINDER_METRIC_MAX_CHARS)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "metric must be a metric key");

/**
 * `?status=` filter on the list endpoint. Accepts one status or a
 * comma-separated set (e.g. `due,surfaced` for the in-app tile). Each token is
 * validated against the closed status enum; an unknown token 422s.
 */
export const coachRemindersListQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(z.enum(COACH_REMINDER_STATUSES)).min(1).optional()),
});

/**
 * Manual create (the ledger "+ add a reminder" path). The note is the only
 * free text; `when` is the closed grammar (resolved server-side into the
 * trigger), `metric` optional. Strict: unknown keys 422.
 */
export const coachReminderCreateSchema = z
  .object({
    note: z.string().trim().min(1).max(REMINDER_NOTE_MAX_CHARS),
    when: whenToken.optional(),
    metric: metricToken.optional(),
  })
  .strict()
  .meta({
    id: "CoachReminderCreate",
    description:
      "Create a Coach reminder manually. `note` is free text (the only writable content). `when` is an optional closed grammar token — an ISO date (YYYY-MM-DD), a relative offset (+Nd / +Nw), or a context cue (NEXT_BP_LOGGED, NEXT_WEIGHT_LOGGED, NEXT_SLEEP_LOGGED, NEXT_APP_OPEN) — resolved into the trigger server-side. Omit `when` for a recall-only note. Strict: unknown keys 422.",
  });

/**
 * The lifecycle PATCH. `status` confirms a proposed reminder (→ active), marks
 * it done / dismissed, or re-activates it. `when` optionally re-schedules
 * (snooze) via the same closed grammar. The body never carries the note text,
 * so a client can never overwrite a reminder's prose — only its lifecycle.
 */
export const coachReminderPatchSchema = z
  .object({
    status: z.enum(COACH_REMINDER_STATUSES).optional(),
    when: whenToken.nullable().optional(),
  })
  .strict()
  .refine(
    (v) => v.status !== undefined || v.when !== undefined,
    "At least one of status or when must be provided",
  )
  .meta({
    id: "CoachReminderPatch",
    description:
      "Update a Coach reminder's lifecycle. `status` confirms (proposed → active), or marks done / dismissed. `when` re-schedules via the closed grammar (null clears the due moment). Never carries the note text. Strict: unknown keys 422.",
  });

// ── Suggested-action confirm endpoint (F6) ──────────────────────────────

const checkupParams = z.object({
  actionType: z.literal("checkup.create"),
  label: z.string().trim().min(1).max(CHECKUP_LABEL_MAX_CHARS),
  interval: z.enum(["yearly", "halfYearly", "quarterly", "monthly"]),
});

const reminderNoteParams = z.object({
  actionType: z.literal("reminder.note"),
  note: z.string().trim().min(1).max(ACTION_NOTE_MAX_CHARS),
  when: whenToken.optional(),
  metric: z
    .string()
    .trim()
    .min(1)
    .max(ACTION_METRIC_MAX_CHARS)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .optional(),
});

/**
 * The confirm-card POST body. `actionType` names a closed-allowlist action; the
 * params are a discriminated union, validated field-by-field. The server resolves
 * every schedule from a closed catalog and builds the entity field-by-field —
 * the client can never mint an arbitrary entity, widen a cadence, or touch a
 * medication / clinical target.
 */
export const coachSuggestedActionSchema = z
  .discriminatedUnion("actionType", [checkupParams, reminderNoteParams])
  .meta({
    id: "CoachSuggestedAction",
    description:
      "Confirm a Coach action card. `actionType` is from the closed allowlist (checkup.create, reminder.note); NEVER a medication or clinical change. `checkup.create` builds a preventive-care Vorsorge reminder (free-text label + a closed interval id resolved to an RRULE server-side); `reminder.note` builds a CoachReminder (note + optional closed `when` grammar + optional metric). Nothing is created without this explicit confirm.",
  });

export type CoachSuggestedActionInput = z.infer<
  typeof coachSuggestedActionSchema
>;
