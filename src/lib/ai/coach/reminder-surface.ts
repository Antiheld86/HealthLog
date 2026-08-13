/**
 * The ONE surfacing step every Coach-reminder trigger converges on.
 *
 * Extracted from the daily sweep so the context-cue evaluators
 * (`context-reminders.ts`) deliver through the exact same transaction a
 * date reminder does: conversation + assistant message + status flip,
 * all-or-nothing. A partial write is the failure this shape exists to
 * remove — a status without a message is a badge pointing at nothing,
 * and a message without a status change re-surfaces the same note on
 * every following trigger.
 *
 * Deterministic and provider-free: the message body is a localized
 * template around the user's OWN note text — the words they asked to be
 * reminded of, never anything generated.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale, locales } from "@/lib/i18n/config";

/** How many notes one surfacing message carries before the rest wait. */
export const MAX_NOTES_PER_MESSAGE = 6;

export type ReminderSurfacePrisma = Pick<
  PrismaClient,
  | "coachReminder"
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
 * The surfacing message for one user's due reminders. Deterministic,
 * localized, and built only from the user's own note text.
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

export interface SurfaceOutcome {
  /** Reminders that reached the conversation in this call. */
  surfaced: number;
  /** Undecryptable notes / failed writes (fault-isolated). */
  errored: number;
}

/**
 * Surface a batch of one user's reminders into their Coach thread.
 *
 * Decrypt is fault-isolated per row — one undecryptable note must not
 * cost the user the reminders beside it. At most `MAX_NOTES_PER_MESSAGE`
 * notes ride one message; the remainder keep their status and surface on
 * the next trigger. A write failure leaves every row untouched: no badge
 * claims a message that was never written.
 */
export async function surfaceCoachReminders(
  prisma: ReminderSurfacePrisma,
  userId: string,
  rows: readonly { id: string; noteEncrypted: Uint8Array }[],
  now: Date,
): Promise<SurfaceOutcome> {
  const outcome: SurfaceOutcome = { surfaced: 0, errored: 0 };
  if (rows.length === 0) return outcome;

  const usable: { id: string; note: string }[] = [];
  for (const row of rows) {
    try {
      usable.push({ id: row.id, note: decryptFromBytes(row.noteEncrypted) });
    } catch {
      outcome.errored += 1;
    }
  }
  if (usable.length === 0) return outcome;

  try {
    const batch = usable.slice(0, MAX_NOTES_PER_MESSAGE);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    });
    const { title, body } = buildReminderSurfaceMessage(
      batch.map((r) => r.note),
      user?.locale,
    );

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
    outcome.surfaced += batch.length;
  } catch {
    outcome.errored += 1;
  }

  return outcome;
}
