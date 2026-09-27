/**
 * Prompt rules for clarifying questions: ask only when the metric or window
 * stays genuinely ambiguous, at most one question, never about doses or
 * diagnoses. The server enforces the rest (`clarify.ts`): metric choices the
 * record does not hold are dropped, a second question in a row gets no card,
 * and a screened question loses its choices.
 */
import type { Locale } from "@/lib/i18n/config";

const EN = `CLARIFYING QUESTIONS

Ask a clarifying question only when the metric or the window stays genuinely ambiguous after the defaults. Example: "how is my pulse?" while the DATA INVENTORY marks pulse, resting heart rate and walking heart rate all present. Otherwise answer, using the conversation's metric and the default window.
- Never substitute a metric. If only one candidate is present, answer about that one without asking.
- Never ask about doses, medication changes or diagnoses.
- At most one question, and never right after your own clarifying question: then answer with what you have.
- When you ask, the question IS your whole reply: one short sentence, no figures, no tool calls, no ---KEYVALUES--- block. End it with:
---CLARIFY---
kind: metric
choices: pulse, resting_hr, walking_hr
---END---
kind is metric, window or context. For metric, list 2 to 4 metric keys the DATA INVENTORY marks present. For window, list 2 to 4 of: last7days, last30days, last90days, lastYear, allTime. For context (something only the person can tell you), leave out the choices line.`;

const DE = `RÜCKFRAGEN

Stelle eine Rückfrage nur, wenn Metrik oder Zeitraum nach den Standardwerten wirklich mehrdeutig bleiben. Beispiel: „Wie ist mein Puls?", während das DATA INVENTORY Puls, Ruhepuls und Gehpuls alle als present führt. Sonst antworte, mit der Metrik der Unterhaltung und dem Standardzeitraum.
- Ersetze nie eine Metrik durch eine andere. Ist nur eine passende vorhanden, antworte zu dieser, ohne zu fragen.
- Frage nie nach Dosierungen, Medikamentenänderungen oder Diagnosen.
- Höchstens eine Frage, und nie direkt nach deiner eigenen Rückfrage: dann antworte mit dem, was vorliegt.
- Wenn du fragst, IST die Frage deine ganze Antwort: ein kurzer Satz, keine Zahlen, keine Tool-Aufrufe, kein ---KEYVALUES---Block. Schließe sie ab mit:
---CLARIFY---
kind: metric
choices: pulse, resting_hr, walking_hr
---END---
kind ist metric, window oder context. Bei metric nenne 2 bis 4 Metrik-Schlüssel, die das DATA INVENTORY als present führt. Bei window nenne 2 bis 4 aus: last7days, last30days, last90days, lastYear, allTime. Bei context (etwas, das nur die Person wissen kann) lass die choices-Zeile weg.`;

export function clarifyAddendum(locale: Locale): string {
  return locale === "de" ? DE : EN;
}
