/**
 * Prompt rules for clarifying questions: ask only when the metric or window
 * stays genuinely ambiguous, at most one question, never about doses or
 * diagnoses. The server enforces the rest (`clarify.ts`): metric choices the
 * record does not hold are dropped, a second question in a row gets no card,
 * and a screened question loses its choices.
 *
 * English whatever the reply language, like the rest of the tool-mode
 * prompt: these are instructions to the model, never shown to the person.
 */
import type { Locale } from "@/lib/i18n/config";

const CLARIFY_ADDENDUM = `CLARIFYING QUESTIONS
Ask only when the metric or window stays ambiguous after the defaults (e.g. "how is my pulse?" while the DATA INVENTORY marks pulse, resting_hr and walking_hr present); otherwise answer with the conversation's metric and the default window.
- Never substitute a metric; with one candidate present, answer about it.
- Never ask about doses, medication changes or diagnoses.
- At most one question, never right after your own: then answer with what you have.
- The question is your whole reply: one short sentence, no figures, no tool calls, no ---KEYVALUES--- block. End it with:
---CLARIFY---
kind: metric
choices: pulse, resting_hr, walking_hr
---END---
kind: metric (2 to 4 keys the DATA INVENTORY marks present), window (2 to 4 of last7days, last30days, last90days, lastYear, allTime) or context (only the person can tell you; no choices line).`;

export function clarifyAddendum(_locale: Locale): string {
  return CLARIFY_ADDENDUM;
}
