import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPromptBody } from "./base-system";
import { withOutputLanguage } from "./output-language";
import { instructionLocale } from "./output-language";

const BMI_SECTION_DE = `METRIK — BMI:
- Der Snapshot trägt bmi.signal (der fertige Vergleich) + bmi.summary + bmi.series (graded). bmi.latestDayFocus zeigt den jüngsten Wert, dessen WHO-Klassifikation und den Schritt zum Vortag; bmi.target ist das grüne Band (18.5-24.9).
- Fokus dieser Karte ist die WHO-BAND-EINORDNUNG, nicht das Gewichtstempo (das trägt die Gewichts-Karte). Setze den Schwerpunkt darauf, in welchem Band der Wert liegt und ob er ein Band wechselt oder sich einer Bandgrenze nähert.
- WHO-Bänder zur groben Einordnung, nie als Etikett für die Person: Untergewicht < 18.5, Normal 18.5-24.9, Übergewicht 25.0-29.9, Adipositas I 30.0-34.9, II 35.0-39.9, III ≥ 40.0. Ab 65+ gilt 22-27 als günstig (DEGAM).
- Bandbezug: Führe mit bmi.signal — current, delta gegenüber baselineLabel und placement (Bandlage) sind bereits berechnet; NENNE sie, rechne sie NICHT neu. Nenne es ausdrücklich, wenn der recent-Wert ein WHO-Band gewechselt hat oder sich (innerhalb ~0.5 BMI-Punkte) einer Bandgrenze nähert. Bleibt der Wert sicher im selben Band, sage das knapp — keine Tempo-Erzählung erzwingen.
- Grenzen des BMI offen ansprechen: Er misst keine Körperzusammensetzung und ist bei muskulösen oder sehr sportlichen Personen wenig aussagekräftig.
- Eine Botschaft: Schließe NUR DANN mit EINEM machbaren Schritt, der zur Bandlage passt, wenn der Befund einen nahelegt — bei stabilem Wert im günstigen Band das ehrlich anerkennen und stattdessen einen Punkt nennen, den man im Auge behalten kann, statt einen Schritt zu erzwingen.`;

const BMI_SECTION_EN = `METRIC — BMI:
- The snapshot carries bmi.signal (the finished comparison) + bmi.summary + bmi.series (graded). bmi.latestDayFocus shows the latest value, its WHO classification and the step from the prior day; bmi.target is the green band (18.5-24.9).
- This card's focus is WHO-BAND placement, not weight pace (the weight card carries that). Centre it on which band the value sits in and whether it crosses a band or nears a band boundary.
- WHO bands for rough placement, never as a label for the person: Underweight < 18.5, Normal 18.5-24.9, Overweight 25.0-29.9, Obesity I 30.0-34.9, II 35.0-39.9, III ≥ 40.0. From age 65+, 22-27 counts as favourable (DEGAM).
- Band reference: lead from bmi.signal — current, delta vs baselineLabel and placement (band position) are already computed; STATE them, do NOT recompute. Call it out explicitly when the recent value has crossed a WHO band or is nearing a band boundary (within ~0.5 BMI points). When the value stays safely inside the same band, say so briefly — do not force a pace narrative.
- Name BMI's limits plainly: it does not measure body composition and is weakly informative for muscular or very athletic people.
- One message: close with ONE doable step that fits the band placement ONLY when the finding implies one — when the value is stable in the favourable band, acknowledge that honestly and name one thing worth keeping an eye on rather than forcing a finding or a step.`;

export function getBmiSystemPrompt(locale: Locale): string {
  // fr/es/it/pl compose the ENGLISH body (the base prompt names their
  // language and appends their own directive); only de takes the German one.
  const section =
    instructionLocale(locale) === "en" ? BMI_SECTION_EN : BMI_SECTION_DE;
  return withOutputLanguage(
    `${getBaseSystemPromptBody(locale)}

${section}`,
    locale,
  );
}

export function getBmiUserPrompt(
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
Write one short assessment of this person's BMI. Open with what its band placement MEANS in plain words — where it sits and whether that's holding or shifting, not the number (e.g. "sitting comfortably in the healthy band", "edging toward the next band up") — then bring in the current value and WHO band right after as support, saying against their own weekly/monthly baseline whether it has crossed a band or is nearing a boundary; never lead with the value. Close with one doable step only when the finding genuinely implies one; when nothing is, skip the step rather than manufacture filler. Leave the weight pace to the weight card. Judge confidence from the measurement count and recency.${ctxBlock}${extraBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey}${openerLine}
Schreibe eine kurze Einschätzung zum BMI dieser Person. Beginne mit der BEDEUTUNG der Bandlage in klaren Worten — wo er liegt und ob das hält oder sich verschiebt, nicht der Zahl (z. B. "liegt bequem im gesunden Band", "nähert sich dem nächsten Band") — und bring danach den aktuellen Wert und das WHO-Band als Beleg, samt Angabe gegen die eigene Wochen-/Monats-Baseline, ob er ein Band gewechselt hat oder sich einer Bandgrenze nähert; führe nie mit dem Wert. Schließe nur dann mit einem machbaren Schritt, wenn der Befund wirklich einen hergibt; ist nichts umsetzbar, lass den Schritt weg statt Fülltext zu erfinden. Das Gewichtstempo bleibt der Gewichts-Karte überlassen. Konfidenz aus Messanzahl und Aktualität ableiten.${ctxBlock}${extraBlock}

${snapshotJson}`;
}
