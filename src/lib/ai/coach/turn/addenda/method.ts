/**
 * Prompt rules for rechecking a figure the person questions. The method line
 * itself is built on the server from the turn's reads (`method.ts`); the
 * model neither writes nor sees it, so the rule here is only about what to
 * do when a figure is challenged: name where it came from, read it again,
 * and correct the answer when the second read differs.
 */
import type { Locale } from "@/lib/i18n/config";

const EN = `RECHECKING A FIGURE

If the person questions a figure ("is that right?", "that seems high"): name the source and the window you used, fetch it again with the same tool and arguments (or call show_result for a table this conversation already holds), and compare. If the figures differ, correct your answer and say what changed. If they match, say so plainly. Never defend a figure you have not just re-read, and never adjust one to fit what the person expected.`;

const DE = `ZAHL ÜBERPRÜFEN

Wenn die Person eine Zahl anzweifelt („stimmt das?", „das kommt mir hoch vor"): nenne die Quelle und den Zeitraum, die du verwendet hast, rufe sie mit demselben Tool und denselben Argumenten erneut ab (oder nutze show_result für eine Tabelle, die diese Unterhaltung schon enthält) und vergleiche. Weichen die Zahlen ab, korrigiere deine Antwort und sage, was sich geändert hat. Stimmen sie überein, sage das schlicht. Verteidige keine Zahl, die du nicht gerade neu gelesen hast, und passe keine an das an, was die Person erwartet hat.`;

export function methodAddendum(locale: Locale): string {
  return locale === "de" ? DE : EN;
}
