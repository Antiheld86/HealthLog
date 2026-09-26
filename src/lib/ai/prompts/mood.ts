import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPromptBody } from "./base-system";
import { withOutputLanguage } from "./output-language";
import { instructionLocale } from "./output-language";

const MOOD_SECTION_DE = `METRIK — STIMMUNG / WOHLBEFINDEN:
- Skala 1 (sehr schlecht) bis 5 (sehr gut). Der Snapshot trägt mood.signal (der fertige Vergleich) + mood.summary + mood.series (graded, Tagesmittel), mood.target (grünes/oranges Band), mood.latestDayFocus und ggf. mood.tags (häufigste Stimmungs-Tags).
- Wochenmuster zählt: Führe mit mood.signal — current, delta gegenüber baselineLabel und outsideNormalSwing sind bereits berechnet. NENNE sie, rechne sie NICHT neu. Behandle outsideNormalSwing: false als "innerhalb der üblichen Schwankung — kein Befund".
- Anhaltende Phasen ernst, aber ruhig benennen: mehrere Tage unter ~2.5 oder über ~4.5 sind erwähnenswert — als Beobachtung, nie als Diagnose und nie alarmierend.
- Bei anhaltend sehr niedriger Stimmung (mehrere Tage deutlich unter ~2.5): biete ruhig und autonomie-wahrend einen Unterstützungs-Pfad an — etwa "bei anhaltender Belastung kann ein Gespräch mit einer Vertrauensperson oder einer Fachperson helfen". Nie alarmierend, nie als Diagnose, kein Notfall-Ton; eine sanfte Option, kein Imperativ.
- Tags: Falls mood.tags vorhanden, kannst du ein wiederkehrendes Tag als möglichen Kontext nennen, ohne einen Zusammenhang zu behaupten.
- Cross-Metrik: crossMetricContext trägt Korrelationen zu Gewicht, Blutdruck und Puls; nur erwähnen, wenn vorhanden und |r| > 0.4 — als Zusammenhang, nie als Ursache. Erzwinge keinen Querverweis ohne klares Muster.
- Eine Botschaft: Schließe NUR DANN mit EINEM machbaren, freundlichen Schritt, wenn der Befund einen nahelegt (z.B. an guten Tagen kurz festhalten, was geholfen hat). Bei stabil guter Stimmung das ehrlich anerkennen und stattdessen einen Punkt nennen, den man im Auge behalten kann, statt einen Schritt zu erzwingen.`;

const MOOD_SECTION_EN = `METRIC — MOOD / WELL-BEING:
- Scale 1 (very bad) to 5 (very good). The snapshot carries mood.signal (the finished comparison) + mood.summary + mood.series (graded daily means), mood.target (green/orange band), mood.latestDayFocus and, where present, mood.tags (most frequent mood tags).
- The weekly pattern matters: lead from mood.signal — current, delta vs baselineLabel and outsideNormalSwing are already computed. STATE them, do NOT recompute. Treat outsideNormalSwing: false as "inside the usual swing — not a finding".
- Name persistent phases seriously but calmly: several days below ~2.5 or above ~4.5 are worth noting — as an observation, never a diagnosis and never alarming.
- When mood stays very low for several days (clearly below ~2.5), offer a support pathway calmly and in an autonomy-preserving way — e.g. "if the strain persists, talking it through with someone you trust or a professional can help". Never alarming, never a diagnosis, no emergency tone; a gentle option, not an imperative.
- Tags: if mood.tags is present, you may name a recurring tag as possible context, without claiming a link.
- Cross-metric: crossMetricContext carries correlations to weight, blood pressure and pulse; mention only when present and |r| > 0.4 — as an association, never a cause. Do not force a cross-link without a clear pattern.
- One message: close with ONE doable, kind step ONLY when the finding implies one (e.g. on good days, briefly note what helped). When mood is steadily good, acknowledge that honestly and name one thing worth keeping an eye on instead of manufacturing a step.`;

export function getMoodSystemPrompt(locale: Locale): string {
  // fr/es/it/pl compose the ENGLISH body (the base prompt names their
  // language and appends their own directive); only de takes the German one.
  const section =
    instructionLocale(locale) === "en" ? MOOD_SECTION_EN : MOOD_SECTION_DE;
  return withOutputLanguage(
    `${getBaseSystemPromptBody(locale)}

${section}`,
    locale,
  );
}

export function getMoodUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
  previousContextBlock?: string,
  /** v1.12.7 — diversity / anti-repetition context; see blood-pressure.ts. */
  assessmentContextBlock?: string,
  /** v1.28.40 — rotating opener-archetype hint; see metric-archetypes.ts. */
  openerHint?: string,
): string {
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
Write one short assessment of this person's mood. Open with what the recent pattern MEANS in plain words — the read, not the number (e.g. "a brighter stretch than usual", "steady, holding where it's been") — then bring in the recent level right after as support, placed against their own weekly/monthly baseline; never lead with the value. Close with one kind, doable step only when the finding genuinely implies one; when nothing is, skip the step rather than manufacture filler. Judge confidence from the entry count and recency.${ctxBlock}${extraBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey}${openerLine}
Schreibe eine kurze Einschätzung zur Stimmung dieser Person. Beginne mit der BEDEUTUNG des jüngsten Musters in klaren Worten — dem Eindruck, nicht der Zahl (z. B. "eine hellere Phase als sonst", "stabil, hält sich, wo sie war") — und bring danach das jüngste Niveau als Beleg, gegen die eigene Wochen-/Monats-Baseline eingeordnet; führe nie mit dem Wert. Schließe nur dann mit einem freundlichen, machbaren Schritt, wenn der Befund wirklich einen hergibt; ist nichts umsetzbar, lass den Schritt weg statt Fülltext zu erfinden. Konfidenz aus Eintragsanzahl und Aktualität ableiten.${ctxBlock}${extraBlock}

${snapshotJson}`;
}
