/**
 * The method line under an answer: which sources, windows, counts and
 * aggregation it rests on, rendered on the server in the request locale.
 * "Blood pressure, last 90 days: 142 readings, weekly means · Sleep: no
 * readings in this window". Never a health value.
 *
 * Not built yet: no method line.
 */
import type { Locale } from "@/lib/i18n/config";
import type {
  CoachMethod,
  CoachResultMeta,
  CoachStep,
} from "@/lib/ai/coach/types";

export function buildMethod(_args: {
  steps: CoachStep[];
  results: CoachResultMeta[];
  locale: Locale;
}): CoachMethod | null {
  return null;
}
