/**
 * The cards a Coach reply may carry beside its prose: a gated cadence
 * suggestion (with its cooldown stamp) and a confirm-to-apply action.
 * Both are dropped when the outbound screen replaced the reply.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import type { CoachSuggestion } from "@/lib/ai/coach/types";
import { gateSuggestion } from "@/lib/ai/coach/suggest-gate";
import type { CoachSuggestedAction } from "@/lib/ai/coach/suggest-action";
import {
  DEFAULT_REMINDER_SUGGESTION_PREFS,
  type CoachPrefs,
} from "@/lib/validations/coach-prefs";

import type { GuardedReply } from "./reply-guards";

export async function surfaceCards(args: {
  userId: string;
  coachPrefs: CoachPrefs;
  reply: GuardedReply;
}): Promise<{
  suggestion: CoachSuggestion | null;
  action: CoachSuggestedAction | null;
}> {
  const { userId, coachPrefs, reply } = args;
  const { suggestParse, actionParse, outboundBlocked } = reply;

  let surfacedSuggestion: CoachSuggestion | null = null;
  if (!outboundBlocked && suggestParse.cadence) {
    const decision = await gateSuggestion({
      prisma,
      userId,
      cadence: suggestParse.cadence,
      prefs:
        coachPrefs.reminderSuggestions ?? DEFAULT_REMINDER_SUGGESTION_PREFS,
    });
    if (decision.surface) {
      const cadence = suggestParse.cadence;
      surfacedSuggestion = {
        cadenceId: cadence.id,
        measurementType: cadence.measurementType,
        label: cadence.labelKey,
      };
      // Stamp the cooldown anchor (frequency cap) onto the prefs blob.
      const nextSuggestionPrefs = {
        ...(coachPrefs.reminderSuggestions ??
          DEFAULT_REMINDER_SUGGESTION_PREFS),
        lastSuggestedAt: new Date().toISOString(),
      };
      void prisma.user
        .update({
          where: { id: userId },
          data: {
            coachPrefsJson: {
              ...coachPrefs,
              reminderSuggestions: nextSuggestionPrefs,
            },
          },
        })
        .catch(() => {
          // Cooldown stamp is best-effort: a write failure at worst lets a
          // second suggestion through sooner, never breaks the chat turn.
        });
      annotate({
        action: { name: "coach.reminder.suggested" },
        meta: { cadenceId: cadence.id, metric: cadence.measurementType },
      });
    } else {
      annotate({
        action: { name: "coach.reminder.suppressed" },
        meta: { cadenceId: suggestParse.cadence.id, reason: decision.reason },
      });
    }
  }
  // v1.22 (F6) — surface the confirm-card action when the turn was not blocked.
  // Additive: the prose already stands alone; the card only offers the one-tap
  // confirm. Nothing is created server-side until the user taps it.
  let surfacedAction: CoachSuggestedAction | null = null;
  if (!outboundBlocked && actionParse.action) {
    surfacedAction = actionParse.action;
    annotate({
      action: { name: "coach.action.suggested" },
      meta: { actionType: actionParse.action.actionType },
    });
  }

  return { suggestion: surfacedSuggestion, action: surfacedAction };
}
