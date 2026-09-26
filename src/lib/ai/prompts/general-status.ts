import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPromptBody } from "./base-system";
import { withOutputLanguage } from "./output-language";
import { instructionLocale } from "./output-language";

const GENERAL_SECTION_DE = `METRIK — GESAMTBEWERTUNG:
- Der Snapshot trägt measurementSeries (eine Map je Metriktyp mit summary + graded series), medicationAdherence (summary + series), bloodPressureTargets (falls vorhanden) und moodContext (falls ≥ 3 Tage). dataCoverage.avgDaysBetweenMeasurements zeigt die Messdichte.
- LÄNGE (überschreibt das Single-Metrik-Budget): Diese Sektion deckt bis zu sechs Metriken ab — schreibe 3-5 Sätze, ca. 50-80 Wörter. Trotzdem knapp und ohne Fülltext.
- Fasse die verfügbaren Parameter zu EINEM kohärenten Bild zusammen — nicht jeden einzeln aufzählen. Nenne HÖCHSTENS zwei Metriken namentlich (die auffälligsten), den Rest nur, wenn er auffällig vom eigenen Mittel abweicht. Priorisiere: das Auffälligste zuerst, Stabiles nur knapp.
- Pro Metrik dieselbe Logik: das recent-Mittel gegen das weekly/monthly-Mittel der Person stellen und nur signifikante Abweichungen von der eigenen Baseline melden.
- Positives ausdrücklich anerkennen — ein stabiler oder sich verbessernder Wert ist eine echte Botschaft, kein Lückenfüller.
- Zusammenhänge nur erwähnen, wenn ein r-Wert im Snapshot vorhanden und |r| > 0.4 ist — als Zusammenhang, nie als Ursache. Stimmung als Kontext einbeziehen, nicht übergewichten.
- Eine Botschaft: Auch über alle Metriken hinweg endet die Einschätzung NUR DANN mit GENAU EINER wichtigsten, machbaren Empfehlung ("eine Sache"), wenn das Gesamtbild eine nahelegt. Ist alles stabil und gibt es nichts Sinnvolles zu tun, sage das ehrlich und nenne stattdessen einen Punkt, den man im Auge behalten kann, statt eine Empfehlung zu erzwingen.`;

const GENERAL_SECTION_EN = `METRIC — OVERALL ASSESSMENT:
- The snapshot carries measurementSeries (a map per metric type with summary + graded series), medicationAdherence (summary + series), bloodPressureTargets (when present) and moodContext (when ≥ 3 days). dataCoverage.avgDaysBetweenMeasurements shows the measurement density.
- LENGTH (overrides the single-metric budget): this section spans up to six metrics — write 3-5 sentences, roughly 50-80 words. Still concise, no filler.
- Pull the available parameters into ONE coherent picture — do not list each separately. Name AT MOST two metrics by name (the most notable ones); mention the rest only when they deviate notably from their own mean. Prioritise: the most notable first, stable values only briefly.
- Same logic per metric: place the recent mean against the person's weekly/monthly mean and report only significant deviations from their own baseline.
- Acknowledge the positive explicitly — a stable or improving value is a real message, not filler.
- Mention associations only when an r-value is present in the snapshot and |r| > 0.4 — as an association, never a cause. Include mood as context, do not over-weight it.
- One message: even across all metrics, close with EXACTLY ONE most-important, doable suggestion ("one thing") ONLY when the overall picture implies one. When everything is steady and there is nothing useful to do, say so honestly and name one thing worth keeping an eye on instead of forcing a recommendation.`;

export function getGeneralStatusSystemPrompt(locale: Locale): string {
  // fr/es/it/pl compose the ENGLISH body (the base prompt names their
  // language and appends their own directive); only de takes the German one.
  const section =
    instructionLocale(locale) === "en"
      ? GENERAL_SECTION_EN
      : GENERAL_SECTION_DE;
  return withOutputLanguage(
    `${getBaseSystemPromptBody(locale)}

${section}`,
    locale,
  );
}

export function getGeneralStatusUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
  previousContextBlock?: string,
  /** v1.12.7 — diversity / anti-repetition context; see blood-pressure.ts. */
  assessmentContextBlock?: string,
  /** v1.28.40 — rotating opener-archetype hint; see metric-archetypes.ts. */
  openerHint?: string,
): string {
  // v1.4: when the previous-analysis context block is supplied, the
  // model is instructed to call out improvements / regressions
  // explicitly. Block already includes the comparison instruction,
  // so we just inject it ahead of the snapshot.
  const ctxBlock =
    previousContextBlock && previousContextBlock.trim().length > 0
      ? `\n\n${previousContextBlock}\n`
      : "";
  const extraBlock =
    assessmentContextBlock && assessmentContextBlock.trim().length > 0
      ? `\n\n${assessmentContextBlock}\n`
      : "";
  const openerLine =
    openerHint && openerHint.trim().length > 0
      ? `\nOPENER HINT: ${openerHint}`
      : "";
  if (instructionLocale(locale) === "en") {
    return `Date: ${todayKey}${openerLine}
Write one short overall assessment across the available health metrics. Open with the overall read in plain words — how things are looking taken together, not a number (e.g. "a steady stretch across the board", "one thing standing out this week") — then bring in the one or two metrics that stand out as support, each placed against the person's own weekly/monthly baseline; never lead with a value. Close with the single most important doable step only when the overall picture genuinely implies one; when nothing is, skip the step rather than manufacture filler. Judge confidence from the measurement count, density and recency.${ctxBlock}${extraBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey}${openerLine}
Schreibe eine kurze Gesamteinschätzung über die verfügbaren Gesundheitsdaten. Beginne mit dem Gesamteindruck in klaren Worten — wie es zusammengenommen aussieht, nicht mit einer Zahl (z. B. "über alles hinweg eine ruhige Phase", "diese Woche sticht eine Sache heraus") — und bring danach die ein bis zwei auffälligsten Metriken als Beleg, jeweils gegen die eigene Wochen-/Monats-Baseline eingeordnet; führe nie mit einem Wert. Schließe nur dann mit dem einen wichtigsten machbaren Schritt, wenn das Gesamtbild wirklich einen hergibt; ist nichts umsetzbar, lass den Schritt weg statt Fülltext zu erfinden. Konfidenz aus Messanzahl, Dichte und Aktualität ableiten.${ctxBlock}${extraBlock}

${snapshotJson}`;
}
