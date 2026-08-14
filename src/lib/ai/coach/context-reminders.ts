/**
 * Context-cue evaluation for Coach reminders (`triggerKind: "context"`).
 *
 * The capture grammar has advertised four cues since v1.22 —
 * NEXT_BP_LOGGED / NEXT_WEIGHT_LOGGED / NEXT_SLEEP_LOGGED /
 * NEXT_APP_OPEN — and the resolver persisted them, but no evaluator
 * existed: the user got a confirmation for a reminder that could never
 * fire. This module is that evaluator.
 *
 * Two triggers, both converging on the same surfacing transaction the
 * date sweep uses (`reminder-surface.ts`):
 *
 *   - `"measurement"` — the three logging cues. Called by the
 *     `reminder-satisfy` worker right after any measurement ingest (the
 *     same eventful hook that auto-resolves Vorsorge reminders), and once
 *     a day by the Coach-reminder sweep as the idempotent backstop. A cue
 *     is satisfied by EVIDENCE, not by the caller's claim: a live row of
 *     a matching type must exist that was LOGGED (row `createdAt`, not
 *     `measuredAt` — back-dating an old paper reading still counts as
 *     logging) after the reminder was captured.
 *
 *   - `"app-open"` — NEXT_APP_OPEN. Evaluated on the nudge-status read,
 *     the cheapest request that fires exactly when the app chrome mounts.
 *     A capture-time grace keeps the reminder from firing into the very
 *     session that created it: "next time you open the app" must not
 *     mean "in the message list you are already looking at". After
 *     surfacing the row leaves the candidate set (`status: "surfaced"`),
 *     so the steady-state cost per read is one indexed query returning
 *     zero rows.
 *
 * Server-only — reads `@/lib/db`-shaped clients (injected).
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";

import type { CoachReminderContextCue } from "@/lib/ai/coach/reminders";
import {
  surfaceCoachReminders,
  type SurfaceOutcome,
} from "@/lib/ai/coach/reminder-surface";

/** Which measurement types count as evidence for each logging cue. */
export const CONTEXT_CUE_MEASUREMENT_TYPES: Partial<
  Record<CoachReminderContextCue, readonly MeasurementType[]>
> = {
  NEXT_BP_LOGGED: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
  NEXT_WEIGHT_LOGGED: ["WEIGHT"],
  NEXT_SLEEP_LOGGED: ["SLEEP_DURATION"],
};

/**
 * How long after capture a NEXT_APP_OPEN reminder stays quiet. The
 * capture happens inside a live Coach chat — the user is demonstrably in
 * the app — so an ungated evaluation would surface the reminder on the
 * very next status poll of the same session.
 */
export const APP_OPEN_GRACE_MS = 15 * 60 * 1000;

export type ContextTrigger = "measurement" | "app-open";

type ContextPrisma = Pick<
  PrismaClient,
  | "coachReminder"
  | "coachConversation"
  | "coachMessage"
  | "measurement"
  | "user"
  | "$transaction"
>;

/** Bound one evaluation pass (a user rarely has >50 reminders — the capture cap). */
const CANDIDATE_BATCH = 100;

/**
 * Evaluate one user's context reminders for one trigger and surface the
 * satisfied ones through the shared delivery transaction. Fault-isolated
 * end to end — a failed evaluation must never fail the ingest or the
 * status read that hosts it.
 */
export async function evaluateCoachContextReminders(
  prisma: ContextPrisma,
  userId: string,
  trigger: ContextTrigger,
  now: Date = new Date(),
): Promise<SurfaceOutcome> {
  const cues: CoachReminderContextCue[] =
    trigger === "app-open"
      ? ["NEXT_APP_OPEN"]
      : (Object.keys(
          CONTEXT_CUE_MEASUREMENT_TYPES,
        ) as CoachReminderContextCue[]);

  // `due` rides along with `active` for the same reason as the date sweep:
  // a row a partial write left mid-flight must resolve, not stick.
  const candidates = await prisma.coachReminder.findMany({
    where: {
      userId,
      deletedAt: null,
      status: { in: ["active", "due"] },
      triggerKind: "context",
      contextCue: { in: cues },
    },
    take: CANDIDATE_BATCH,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      noteEncrypted: true,
      contextCue: true,
      createdAt: true,
    },
  });
  if (candidates.length === 0) return { surfaced: 0, errored: 0 };

  const satisfied: { id: string; noteEncrypted: Uint8Array }[] = [];
  let errored = 0;

  for (const reminder of candidates) {
    try {
      if (reminder.contextCue === "NEXT_APP_OPEN") {
        if (now.getTime() - reminder.createdAt.getTime() >= APP_OPEN_GRACE_MS) {
          satisfied.push(reminder);
        }
        continue;
      }
      const types =
        CONTEXT_CUE_MEASUREMENT_TYPES[
          reminder.contextCue as CoachReminderContextCue
        ];
      if (!types) continue; // unknown cue — never guess
      // Evidence check: a live matching-type row logged after capture.
      const evidence = await prisma.measurement.findFirst({
        where: {
          userId,
          type: { in: [...types] },
          deletedAt: null,
          createdAt: { gt: reminder.createdAt },
        },
        select: { id: true },
      });
      if (evidence) satisfied.push(reminder);
    } catch {
      errored += 1;
    }
  }

  if (satisfied.length === 0) return { surfaced: 0, errored };

  const outcome = await surfaceCoachReminders(prisma, userId, satisfied, now);
  return { surfaced: outcome.surfaced, errored: errored + outcome.errored };
}
