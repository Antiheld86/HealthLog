/**
 * Prompt rules for clarifying questions: ask only when the metric or window
 * stays genuinely ambiguous, at most one question, never about doses or
 * diagnoses.
 *
 * Not written yet: empty.
 */
import type { Locale } from "@/lib/i18n/config";

export function clarifyAddendum(_locale: Locale): string {
  return "";
}
