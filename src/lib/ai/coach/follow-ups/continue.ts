/**
 * "Keep looking": when the loop forced an answer at its round cap, offer a
 * chip that continues the question with what was already fetched.
 *
 * Not built yet: no chip.
 */
import type { Locale } from "@/lib/i18n/config";
import type { CoachFollowUp } from "@/lib/ai/coach/types";

export function buildContinueFollowUp(_args: {
  forcedFinal: boolean;
  locale: Locale;
}): CoachFollowUp | null {
  return null;
}
