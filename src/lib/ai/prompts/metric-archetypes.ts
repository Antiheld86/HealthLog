/**
 * v1.8.7.1 — archetype prompt templates for the generic per-metric
 * assessment generator.
 *
 * The seven specialised status cards each ship a bespoke
 * `src/lib/ai/prompts/<metric>.ts`. Hand-writing ~30 more for the
 * HealthKit metric pages is not viable, so this module parameterises one
 * template per archetype (five) plus a dedicated `sleep` template. Each
 * template is driven entirely by the metric metadata (display name,
 * unit, direction, normal range) + the same graded snapshot shape the
 * specialised cards send, so a new metric in the registry produces a
 * grounded assessment without a new prompt.
 *
 * Every template extends `getBaseSystemPrompt` (the shared "one short,
 * grounded, warm assessment paragraph → { summary }" contract) and adds
 * a per-archetype section describing how to read THAT family of metrics
 * (a vital is a point-in-time reading placed against a normal range; an
 * activity metric is a cumulative daily count, mostly higher-better; a
 * mobility metric is a stability signal; …). The user prompt then ships
 * the snapshot JSON + the metric metadata + the optional previous-context
 * block, exactly like the specialised generators.
 */
import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPromptBody } from "./base-system";
import { instructionLocale, withOutputLanguage } from "./output-language";
import type {
  MetricArchetype,
  MetricStatusMeta,
} from "@/lib/insights/metric-status-registry";

function directionPhrase(meta: MetricStatusMeta, locale: Locale): string {
  if (instructionLocale(locale) === "en") {
    switch (meta.direction) {
      case "higher-better":
        return "Higher values are generally more favourable for this metric.";
      case "lower-better":
        return "Lower values are generally more favourable for this metric.";
      case "target-band":
        return "Neither extreme is good — the value should sit inside its normal band; deviations in either direction are worth noting.";
    }
  }
  switch (meta.direction) {
    case "higher-better":
      return "Höhere Werte sind bei dieser Metrik tendenziell günstiger.";
    case "lower-better":
      return "Niedrigere Werte sind bei dieser Metrik tendenziell günstiger.";
    case "target-band":
      return "Kein Extrem ist gut — der Wert sollte im Normalband liegen; Abweichungen in beide Richtungen sind erwähnenswert.";
  }
}

/**
 * Render the metric-metadata block both the system section and the user
 * prompt reference. Kept terse — the snapshot carries the numbers, this
 * just tells the model what it is looking at.
 */
function metaBlock(meta: MetricStatusMeta, locale: Locale): string {
  const range = meta.normalRange
    ? instructionLocale(locale) === "en"
      ? `Coarse population reference band: ${meta.normalRange.low}–${meta.normalRange.high} ${meta.unit} (a placement aid only — the user's OWN baseline leads).`
      : `Grobes Referenzband (Population): ${meta.normalRange.low}–${meta.normalRange.high} ${meta.unit} (nur Orientierung — die EIGENE Baseline führt).`
    : instructionLocale(locale) === "en"
      ? "No fixed population band applies — judge purely against the user's own baseline."
      : "Kein festes Referenzband — beurteile rein gegen die eigene Baseline der Person.";
  if (instructionLocale(locale) === "en") {
    return [
      `METRIC: ${meta.displayName} (unit: ${meta.unit}).`,
      directionPhrase(meta, locale),
      range,
    ].join("\n");
  }
  return [
    `METRIK: ${meta.displayName} (Einheit: ${meta.unit}).`,
    directionPhrase(meta, locale),
    range,
  ].join("\n");
}

const ARCHETYPE_SECTION: Record<MetricArchetype, { de: string; en: string }> = {
  "physiological-vital": {
    en: "ARCHETYPE — PHYSIOLOGICAL VITAL:\n- This is a point-in-time physiological reading. Name the recent level, place it against both the user's own baseline (recent vs monthly/yearly mean) and, when a reference band is given, that band.\n- A single out-of-band reading is rarely a finding; a sustained shift across the recent window against the user's baseline is. Note an out-of-band trend without alarm.\n- Frame any direction (rising/falling) as a possible explanation (fitness, stress, sleep, illness, medication), never a diagnosis.",
    de: "ARCHETYP — PHYSIOLOGISCHER VITALWERT:\n- Das ist ein Momentanwert. Benenne das aktuelle Niveau und ordne es sowohl gegen die eigene Baseline (recent vs. Monats-/Jahresmittel) als auch — falls ein Referenzband vorliegt — gegen dieses Band ein.\n- Ein einzelner Wert außerhalb des Bands ist selten ein Befund; eine anhaltende Verschiebung über das recent-Fenster gegen die Baseline schon. Erwähne einen Trend außerhalb des Bands sachlich, ohne zu alarmieren.\n- Formuliere jede Richtung (steigend/fallend) als mögliche Erklärung (Fitness, Stress, Schlaf, Krankheit, Medikament), nie als Diagnose.",
  },
  "activity-fitness": {
    en: "ARCHETYPE — ACTIVITY / FITNESS:\n- This is a daily activity or fitness measure, mostly higher-better. Read the recent daily mean and compare it to the user's own weekly/monthly baseline — is their activity up, down, or steady?\n- Day-to-day swings are expected; report the multi-day trend, not a single low or high day. When a reference band is given, use it as a coarse target, not a verdict.\n- Close with one doable, specific step toward more (or sustained) movement ONLY when the finding implies one — never the generic 'exercise more' platitude. When activity is steady and already strong, affirm it and name one thing worth keeping an eye on instead of manufacturing a step.",
    de: "ARCHETYP — AKTIVITÄT / FITNESS:\n- Das ist ein tägliches Aktivitäts- oder Fitnessmaß, meist höher = besser. Lies das recent-Tagesmittel und vergleiche es mit der eigenen Wochen-/Monats-Baseline — ist die Aktivität gestiegen, gesunken oder stabil?\n- Tagesschwankungen sind normal; melde den Mehrtagestrend, nicht einen einzelnen niedrigen oder hohen Tag. Ein Referenzband ist ein grobes Ziel, kein Urteil.\n- Schließe NUR DANN mit einem machbaren, konkreten Schritt für mehr (oder gleichbleibende) Bewegung, wenn der Befund einen nahelegt — nie die generische Floskel 'mehr Bewegung'. Ist die Aktivität stabil und bereits gut, erkenne das an und nenne stattdessen einen Punkt, den man im Auge behalten kann, statt einen Schritt zu erzwingen.",
  },
  "body-composition": {
    en: "ARCHETYPE — BODY COMPOSITION:\n- This is a body-composition mass (or rating). A healthy absolute value depends entirely on body size, so judge the TREND toward or away from the user's own baseline, not an absolute number.\n- Report a sustained directional change across weeks/months; single readings carry scale + hydration noise. Tie it to weight context only if the snapshot supports it.\n- Close with one step that supports the favourable direction for THIS metric ONLY when the finding implies one. When the trend is steady and favourable, affirm it and name one thing worth keeping an eye on instead of manufacturing a step.",
    de: "ARCHETYP — KÖRPERZUSAMMENSETZUNG:\n- Das ist eine Körperzusammensetzungs-Masse (oder Bewertung). Ein gesunder Absolutwert hängt stark von der Körpergröße ab — beurteile den TREND zur bzw. weg von der eigenen Baseline, nicht eine Absolutzahl.\n- Melde eine anhaltende Richtungsänderung über Wochen/Monate; Einzelwerte tragen Waagen- und Hydrationsrauschen. Stelle einen Gewichtsbezug nur her, wenn der Snapshot ihn stützt.\n- Schließe NUR DANN mit einem Schritt, der die für DIESE Metrik günstige Richtung unterstützt, wenn der Befund einen nahelegt. Ist der Trend stabil und günstig, erkenne das an und nenne stattdessen einen Punkt, den man im Auge behalten kann, statt einen Schritt zu erzwingen.",
  },
  "mobility-gait": {
    en: "ARCHETYPE — MOBILITY / GAIT:\n- This is a gait/mobility-stability signal Apple surfaces in its Mobility section. Its value is as a stability + anomaly flag: a steady reading near the user's baseline is reassuring; a sustained drift in the unfavourable direction is the signal to surface.\n- These metrics move slowly; one off day is noise. Only flag a multi-week drift, and frame it as a mobility observation, never a fall-risk diagnosis.\n- If steady, say so plainly. If drifting unfavourably, give one gentle, doable step.",
    de: "ARCHETYP — MOBILITÄT / GANG:\n- Das ist ein Gang-/Mobilitäts-Stabilitätssignal aus Apples Mobilitätsbereich. Sein Wert liegt als Stabilitäts- und Anomalie-Flag: ein stabiler Wert nahe der Baseline beruhigt; eine anhaltende Drift in die ungünstige Richtung ist das Signal.\n- Diese Werte ändern sich langsam; ein Ausreißertag ist Rauschen. Melde nur eine mehrwöchige Drift und formuliere sie als Mobilitätsbeobachtung, nie als Sturzrisiko-Diagnose.\n- Ist es stabil, sage das klar. Driftet es ungünstig, gib einen sanften, machbaren Schritt.",
  },
  "environmental-exposure": {
    en: "ARCHETYPE — ENVIRONMENTAL EXPOSURE:\n- This is an environmental exposure (sound level / loud-event count), lower-better. The reference band is a threshold (e.g. WHO 80 dBA) — recent values above it sustained across days are the finding worth surfacing.\n- A single loud concert or flight is not a pattern. Report repeated above-threshold exposure, not an isolated spike.\n- Close with one practical step to reduce exposure (e.g. lower the listening volume, take a quiet break) — framed as protective, never alarming.",
    de: "ARCHETYP — UMWELT-EXPOSITION:\n- Das ist eine Umwelt-Exposition (Schallpegel / Anzahl lauter Ereignisse), niedriger = besser. Das Referenzband ist ein Schwellenwert (z.B. WHO 80 dBA) — recent-Werte, die ihn über mehrere Tage überschreiten, sind der erwähnenswerte Befund.\n- Ein einzelnes lautes Konzert oder ein Flug ist kein Muster. Melde wiederholte Überschreitungen, nicht einen Einzelausschlag.\n- Schließe mit einem praktischen Schritt zur Reduktion (z.B. Hörlautstärke senken, eine ruhige Pause) — schützend formuliert, nie alarmierend.",
  },
  sleep: {
    en: "ARCHETYPE — SLEEP:\n- This is nightly sleep duration. The snapshot's values are in minutes; convert to hours for your prose (e.g. 450 min = 7.5 h). Assess both the typical duration and its CONSISTENCY: a stable ~7–9 h is the favourable pattern; high night-to-night variability is itself worth naming even when the mean looks fine.\n- Compare the recent nights to the user's own weekly/monthly baseline. A reference band of 7–9 h is a coarse adult guide, not a verdict — short or long sleepers vary.\n- Close with one doable step toward more consistent or sufficient sleep ONLY when the finding implies one — never the forbidden 'get enough sleep' platitude; be specific (e.g. a steadier wind-down time). When sleep is already consistent and sufficient, affirm it and name one thing worth keeping an eye on instead of manufacturing a step.",
    de: "ARCHETYP — SCHLAF:\n- Das ist die nächtliche Schlafdauer. Die Snapshot-Werte sind in Minuten; rechne für deinen Text in Stunden um (z.B. 450 min = 7,5 h). Bewerte sowohl die typische Dauer als auch ihre KONSTANZ: stabile ~7–9 h sind das günstige Muster; hohe Schwankung von Nacht zu Nacht ist selbst dann erwähnenswert, wenn der Mittelwert passt.\n- Vergleiche die jüngsten Nächte mit der eigenen Wochen-/Monats-Baseline. Ein Referenzband von 7–9 h ist eine grobe Erwachsenen-Orientierung, kein Urteil — Kurz- und Langschläfer variieren.\n- Schließe NUR DANN mit einem machbaren Schritt zu konstanterem oder ausreichenderem Schlaf, wenn der Befund einen nahelegt — nie die verbotene Floskel 'achte auf ausreichend Schlaf'; sei konkret (z.B. eine festere Einschlafzeit). Ist der Schlaf bereits konstant und ausreichend, erkenne das an und nenne stattdessen einen Punkt, den man im Auge behalten kann, statt einen Schritt zu erzwingen.",
  },
};

export function getMetricArchetypeSystemPrompt(
  meta: MetricStatusMeta,
  locale: Locale,
): string {
  const section = ARCHETYPE_SECTION[meta.archetype];
  const archetypeText =
    instructionLocale(locale) === "en" ? section.en : section.de;
  return withOutputLanguage(
    `${getBaseSystemPromptBody(locale)}

${archetypeText}

${metaBlock(meta, locale)}`,
    locale,
  );
}

export function getMetricArchetypeUserPrompt(
  meta: MetricStatusMeta,
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
  previousContextBlock?: string,
  /**
   * v1.12.1 — diversity / anti-repetition context (variety lead, data
   * strength, steady-run repetition signal, cross-metric relations). All
   * grounded in already-computed data; optional and may be empty.
   */
  assessmentContextBlock?: string,
  /**
   * v1.27.13 (Welle J) — the guideline interpretation block (band table +
   * server-computed position) for metrics the knowledge base covers. Absent
   * for metrics with no guideline band — the prompt then stays personal-
   * relative, exactly as before.
   */
  interpretationBlock?: string,
  /**
   * v1.28.40 — the rotating opener-archetype hint (VERDICT / TREND / CONTRAST /
   * CONTINUITY / MEANING). When present it is emitted as an `OPENER HINT:` line
   * so the base prompt's "Lead per the OPENER HINT … do NOT open with the
   * number" branch fires. Optional so tests can omit it; production always
   * passes it from `metric-status.ts`.
   */
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
  const interpBlock =
    interpretationBlock && interpretationBlock.trim().length > 0
      ? `\n\n${interpretationBlock}\n`
      : "";
  const openerLine =
    openerHint && openerHint.trim().length > 0
      ? `\nOPENER HINT: ${openerHint}`
      : "";
  if (instructionLocale(locale) === "en") {
    return `Date: ${todayKey}${openerLine}
Write one short assessment of this person's ${meta.displayName.toLowerCase()}. Open with what it MEANS in plain words — the read, not the number (e.g. "running a little calmer than usual", "steady and right where it's been") — then bring in ONE concrete number from the snapshot right after as support, placed against their own weekly/monthly baseline; never lead with the value. Close with one doable step only when the finding genuinely implies one; when nothing is, skip the step rather than manufacture filler. Judge confidence from the measurement count and recency.${ctxBlock}${extraBlock}${interpBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey}${openerLine}
Schreibe eine kurze Einschätzung zu ${meta.displayName} dieser Person. Beginne mit der BEDEUTUNG in klaren Worten — dem Eindruck, nicht der Zahl (z. B. "läuft gerade etwas ruhiger als sonst", "stabil und genau da, wo es war") — und bring danach EINE konkrete Zahl aus dem Snapshot als Beleg, gegen die eigene Wochen-/Monats-Baseline eingeordnet; führe nie mit dem Wert. Schließe nur dann mit einem machbaren Schritt, wenn der Befund wirklich einen hergibt; ist nichts umsetzbar, lass den Schritt weg statt Fülltext zu erfinden. Konfidenz aus Messanzahl und Aktualität ableiten.${ctxBlock}${extraBlock}${interpBlock}

${snapshotJson}`;
}
