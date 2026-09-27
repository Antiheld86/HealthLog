import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPromptBody } from "./base-system";
import { withOutputLanguage } from "./output-language";
import { instructionLocale } from "./output-language";

const BP_SECTION_DE = `METRIK — BLUTDRUCK:
- Der Snapshot trägt systolisch (bloodPressure.systolic) und diastolisch (bloodPressure.diastolic) jeweils mit signal (der fertige Vergleich) + summary + graded series; beurteile beide Komponenten GEMEINSAM, nie isoliert.
- Tendenz über Tage/Wochen: Führe mit bloodPressure.systolic.signal und bloodPressure.diastolic.signal — current, delta gegenüber baselineLabel und outsideNormalSwing sind bereits berechnet. NENNE sie, rechne sie NICHT neu. Behandle outsideNormalSwing: false als "innerhalb der üblichen Schwankung — kein Befund".
- Leitlinien-Anker (ESH 2023), zur Einordnung, nicht zur Diagnose:
  * Optimal < 120/80, normal 120-129/80-84, hochnormal 130-139/85-89.
  * Hypertonie Grad 1 ab 140/90, Grad 2 ab 160/100, Grad 3 ab 180/110.
  * Übliches Behandlungsziel bei unkomplizierter Hypertonie < 130/80 (18-69 J.), < 140/80 (≥ 70 J.).
- targets: Falls bloodPressure.targets vorhanden, ordne gegen das persönliche Zielband ein; inTargetPctLast30DailyPoints ist der Anteil der letzten Tage im Ziel.
- Medikamenten-Bezug: bpMedications trägt compliance7/compliance30. bpMedicationContinuityVsSystolic.correlation und weightVsSystolic.correlation nur erwähnen, wenn vorhanden und |r| > 0.4 — als Zusammenhang, nie als Ursache.
- Stimmung: moodContext.moodVsSystolicCorrelation nur erwähnen, wenn vorhanden und |r| > 0.4.
- Eine Botschaft: Wenn die Werte über der Baseline liegen, schließe NUR DANN mit EINEM machbaren Schritt, wenn der Befund einen nahelegt (z.B. ein paar Tage zur selben Uhrzeit nachmessen, oder — bei lückenhafter Einnahmetreue — die Einnahme verlässlicher machen). Bei stabilen Werten im Ziel: das ehrlich anerkennen und stattdessen einen Punkt nennen, den man im Auge behalten kann, statt einen Schritt zu erzwingen.`;

const BP_SECTION_EN = `METRIC — BLOOD PRESSURE:
- The snapshot carries systolic (bloodPressure.systolic) and diastolic (bloodPressure.diastolic), each with a signal (the finished comparison) + summary + graded series; judge both components TOGETHER, never in isolation.
- Trend over days/weeks: lead from bloodPressure.systolic.signal and bloodPressure.diastolic.signal — current, delta vs baselineLabel and outsideNormalSwing are already computed. STATE them, do NOT recompute. Treat outsideNormalSwing: false as "inside the usual swing — not a finding".
- Guideline anchors (ESH 2023), for placement, not diagnosis:
  * Optimal < 120/80, normal 120-129/80-84, high-normal 130-139/85-89.
  * Hypertension grade 1 from 140/90, grade 2 from 160/100, grade 3 from 180/110.
  * Common treatment target for uncomplicated hypertension < 130/80 (age 18-69), < 140/80 (age ≥ 70).
- targets: if bloodPressure.targets is present, place values against the personal target band; inTargetPctLast30DailyPoints is the share of recent days in target.
- Medication link: bpMedications carries compliance7/compliance30. Mention bpMedicationContinuityVsSystolic.correlation and weightVsSystolic.correlation only when present and |r| > 0.4 — as an association, never a cause.
- Mood: mention moodContext.moodVsSystolicCorrelation only when present and |r| > 0.4.
- One message: if the values sit above the person's baseline, close with ONE doable step ONLY when the finding implies one (e.g. take a few readings at the same time of day for a few days, or — when adherence is patchy — make the medication routine more reliable). When values are stable and in target, say so honestly and name one thing worth keeping an eye on instead of manufacturing a step.`;

export function getBloodPressureSystemPrompt(locale: Locale): string {
  // fr/es/it/pl compose the ENGLISH body (the base prompt names their
  // language and appends their own directive); only de takes the German one.
  const section =
    instructionLocale(locale) === "en" ? BP_SECTION_EN : BP_SECTION_DE;
  return withOutputLanguage(
    `${getBaseSystemPromptBody(locale)}

${section}`,
    locale,
  );
}

export function getBloodPressureUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
  previousContextBlock?: string,
  /**
   * v1.12.7 — diversity / anti-repetition context (variety lead, data
   * strength, steady-run repetition signal, cross-metric relations), the
   * same block the archetype cards carry. Grounded in already-computed
   * data; optional and may be empty.
   */
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
Write one short assessment of this person's blood pressure. Open with what the reading MEANS in plain words — the overall read, not the number (e.g. "calm and right where you want it", "running a touch higher than your usual this week") — then bring in the systolic/diastolic figures right after as support, judged as ONE pair and placed against their own weekly/monthly baseline; never lead with the numbers. Close with one doable step only when the finding genuinely implies one; when nothing is, skip the step rather than manufacture filler. Judge confidence from the measurement count and recency.${ctxBlock}${extraBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey}${openerLine}
Schreibe eine kurze Einschätzung zum Blutdruck dieser Person. Beginne mit der BEDEUTUNG in klaren Worten — dem Gesamteindruck, nicht der Zahl (z. B. "ruhig und genau da, wo du ihn haben willst", "diese Woche einen Tick höher als sonst") — und bring danach die systolischen/diastolischen Werte als Beleg, als EIN Paar beurteilt und gegen die eigene Wochen-/Monats-Baseline eingeordnet; führe nie mit den Werten. Schließe nur dann mit einem machbaren Schritt, wenn der Befund wirklich einen hergibt; ist nichts umsetzbar, lass den Schritt weg statt Fülltext zu erfinden. Konfidenz aus Messanzahl und Aktualität ableiten.${ctxBlock}${extraBlock}

${snapshotJson}`;
}
