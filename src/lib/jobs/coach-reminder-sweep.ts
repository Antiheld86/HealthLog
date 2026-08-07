/**
 * v1.22 (B2/M4) — daily Coach-reminder sweep.
 *
 * The active scheduler the "remind me" complaint needs: a single indexed query
 * per tick that brings a reminder back at its chosen moment. Two sources:
 *
 *   1. `CoachReminder` rows that are date-triggered, `active`, and whose `dueAt`
 *      has passed.
 *   2. `CoachPlan` rows whose dangling `reviewDate` (written nowhere, read
 *      nowhere until now — see the design §1c) has passed and that are still
 *      `active` → a one-off `CoachReminder` is minted from the plan's own
 *      cue→action text (relatedPlanId set, source `extractor`) and the plan's
 *      `reviewDate` is cleared so the review fires once. This finally activates
 *      the column the B1 schema anticipated.
 *
 * Both sources converge on ONE surfacing step, and that convergence is the
 * point. Until v1.37 the sweep only flipped a reminder's status to `due` and
 * stopped: nothing was written into the conversation, `surfaced` had no writer
 * at all, and the FAB lit its unread dot off a separate "is anything due?"
 * query. So the dot appeared over an empty Coach, opening it showed the empty
 * state, and opening it did not clear the dot either — the only way out was to
 * resolve the reminder in Settings, which nothing on the badge suggested. A
 * badge and the content it promises must come from one event.
 *
 * They do now. Surfacing writes the reminder into the user's Coach thread as a
 * real assistant message and flips the reminder to `surfaced` in the SAME
 * transaction, so the two cannot drift: no message, no status change, no
 * badge. The badge itself is derived from that message
 * (`readCoachNudgeStatus` compares the newest assistant message against
 * `User.coachLastSeenAt`), which means opening the Coach clears it the way it
 * clears any other proactive message.
 *
 * Rows left `due` by an older build are picked up by the same pass, so a badge
 * that has been stuck on an empty conversation resolves into the message it
 * always implied rather than staying stuck.
 *
 * The sweep still never calls a provider and never pushes. The message body is
 * a deterministic localized template around the user's OWN note text — the
 * words they asked to be reminded of, never anything fabricated.
 *
 * Context-cue reminders (`triggerKind: "context"`) are NOT evaluated here — that
 * is a follow-on (F4); the column exists and capture supports it, but the date
 * sweep is the high-value slice.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale, locales } from "@/lib/i18n/config";

export const COACH_REMINDER_SWEEP_QUEUE = "coach-reminder-sweep";
// Daily at 05:20 Europe/Berlin — just after the 05:15 nudge tick so both
// proactive passes run on settled overnight rows.
export const COACH_REMINDER_SWEEP_CRON = "20 5 * * *";

/** Bound the plan-review fan-out per tick so one sweep can't run unbounded. */
const PLAN_REVIEW_BATCH = 200;
/** Bound the surfacing fan-out per tick for the same reason. */
const SURFACE_BATCH = 500;
/** How many notes one surfacing message carries before the rest wait a tick. */
const MAX_NOTES_PER_MESSAGE = 6;

export interface CoachReminderSweepSummary {
  /** Reminders whose moment arrived AND that reached the conversation. */
  remindersDue: number;
  planReviewsMinted: number;
  errored: number;
}

type SweepPrisma = Pick<
  PrismaClient,
  | "coachReminder"
  | "coachPlan"
  | "coachConversation"
  | "coachMessage"
  | "user"
  | "$transaction"
>;

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * The surfacing message for one user's due reminders. Deterministic, localized,
 * and built only from the user's own note text — the sweep composes, it never
 * generates.
 */
export function buildReminderSurfaceMessage(
  notes: readonly string[],
  locale: string | null | undefined,
): { title: string; body: string } {
  const t = getServerTranslator(resolveLocale(locale)).t;
  const title = t("coachNudges.reminderSurfacedTitle");
  const lead =
    notes.length === 1
      ? t("coachNudges.reminderSurfacedLeadOne")
      : t("coachNudges.reminderSurfacedLeadMany", { count: notes.length });
  const body = [lead, ...notes.map((n) => `• ${n}`)].join("\n");
  return { title, body };
}

/**
 * Run one sweep tick. Idempotent: a reminder already `surfaced` is not
 * re-surfaced, and a plan whose `reviewDate` was cleared on a prior tick is not
 * re-minted.
 */
export async function runCoachReminderSweep(
  prisma: SweepPrisma,
  now: Date = new Date(),
): Promise<CoachReminderSweepSummary> {
  const summary: CoachReminderSweepSummary = {
    remindersDue: 0,
    planReviewsMinted: 0,
    errored: 0,
  };

  // ── 1. mint plan-review reminders for passed reviewDates ──────
  //
  // Minted `active` with `dueAt: now` so the surfacing pass below picks them
  // up in this same tick. One path reaches the conversation, not two.
  const plans = await prisma.coachPlan.findMany({
    where: {
      deletedAt: null,
      status: "active",
      reviewDate: { not: null, lte: now },
    },
    take: PLAN_REVIEW_BATCH,
    select: {
      id: true,
      userId: true,
      metric: true,
      ifCueEncrypted: true,
      thenActionEncrypted: true,
    },
  });

  for (const plan of plans) {
    try {
      // The note is the plan's OWN cue→action prose (the user's words), never
      // fabricated. Decrypt fault-isolated — an undecryptable plan is skipped
      // (its reviewDate stays so a future key fix can still surface it).
      let note: string;
      try {
        const ifCue = decryptFromBytes(plan.ifCueEncrypted);
        const thenAction = decryptFromBytes(plan.thenActionEncrypted);
        note = `${ifCue} → ${thenAction}`.slice(0, 280);
      } catch {
        summary.errored += 1;
        continue;
      }

      // Mint the reminder and clear the plan's reviewDate atomically: if the
      // clear failed after a standalone create committed, the next tick would
      // re-select the plan (reviewDate still set) and mint a DUPLICATE review
      // reminder. One transaction makes the pair all-or-nothing.
      await prisma.$transaction([
        prisma.coachReminder.create({
          data: {
            userId: plan.userId,
            noteEncrypted: encryptToBytes(note),
            metric: plan.metric,
            relatedPlanId: plan.id,
            triggerKind: "date",
            dueAt: now,
            status: "active",
            source: "extractor",
          },
        }),
        prisma.coachPlan.update({
          where: { id: plan.id },
          data: { reviewDate: null },
        }),
      ]);
      summary.planReviewsMinted += 1;
    } catch {
      summary.errored += 1;
    }
  }

  // ── 2. surface everything whose moment has passed ─────────────
  //
  // `due` is included alongside `active` deliberately: rows an older build
  // flipped to `due` never reached a conversation, and they are exactly the
  // ones showing a badge with nothing behind it. Picking them up here converts
  // a stuck indicator into the message it always promised.
  const overdue = await prisma.coachReminder.findMany({
    where: {
      deletedAt: null,
      status: { in: ["active", "due"] },
      triggerKind: "date",
      dueAt: { not: null, lte: now },
    },
    take: SURFACE_BATCH,
    orderBy: { dueAt: "asc" },
    select: { id: true, userId: true, noteEncrypted: true },
  });

  const byUser = new Map<string, typeof overdue>();
  for (const row of overdue) {
    const bucket = byUser.get(row.userId);
    if (bucket) bucket.push(row);
    else byUser.set(row.userId, [row]);
  }

  for (const [userId, rows] of byUser) {
    try {
      // Decrypt fault-isolated per row: one undecryptable note must not cost
      // the user the reminders that sit beside it.
      const usable: { id: string; note: string }[] = [];
      for (const row of rows) {
        try {
          usable.push({
            id: row.id,
            note: decryptFromBytes(row.noteEncrypted),
          });
        } catch {
          summary.errored += 1;
        }
      }
      if (usable.length === 0) continue;

      const batch = usable.slice(0, MAX_NOTES_PER_MESSAGE);
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true },
      });
      const { title, body } = buildReminderSurfaceMessage(
        batch.map((r) => r.note),
        user?.locale,
      );

      // Conversation + message + status flip in ONE transaction. A partial
      // write is the failure this whole change exists to remove: a status
      // without a message is a badge pointing at nothing, and a message
      // without a status change re-surfaces the same note every night.
      await prisma.$transaction(async (tx) => {
        const conversation = await tx.coachConversation.create({
          data: { userId, title: title.slice(0, 80) },
        });
        await tx.coachMessage.create({
          data: {
            conversationId: conversation.id,
            role: "assistant",
            encryptedContent: encryptToBytes(body),
            metricSourceJson: null,
            // Same tag the proactive nudge uses — this IS a proactive message,
            // and the nudge cron's frequency gate reads the tag back.
            providerType: "nudge",
            promptVersion: null,
          },
        });
        await tx.coachReminder.updateMany({
          where: { id: { in: batch.map((r) => r.id) } },
          data: {
            status: "surfaced",
            lastSurfacedAt: now,
            surfaceCount: { increment: 1 },
          },
        });
      });
      summary.remindersDue += batch.length;
    } catch {
      // Leave the rows where they were: the next tick retries, and until then
      // no badge claims a message that was never written.
      summary.errored += 1;
    }
  }

  return summary;
}
