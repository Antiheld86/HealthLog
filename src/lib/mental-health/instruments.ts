/**
 * v1.25 — validated mental-health screener definitions (PHQ-9 + GAD-7).
 * v1.27.9 — the registry generalises to carry the WHO-5 well-being index and
 * the Sleep Condition Indicator (SCI) on the same infrastructure: per-item
 * answer scales, response-option schemes, score direction, and the reported
 * total (WHO-5 reports raw-sum × 4 as a 0–100 percentage) are now instrument
 * properties instead of PHQ/GAD assumptions.
 *
 * Pure, server-authoritative scoring. Item wording, response anchors, scoring
 * and band thresholds are taken from the primary sources only:
 *   - PHQ-9: Kroenke 2001; GAD-7: Spitzer 2006 (public-domain Pfizer grant).
 *   - WHO-5: WHO/UCN/MSD/MHE/2024.1 (© WHO 2024, CC BY-NC-SA 3.0 IGO) — raw
 *     0–25, × 4 → 0–100; "a percentage score below 50 … an indication for
 *     further assessment". Six app locales ship the WHO/PRU translations
 *     verbatim; Korean, which neither distribution carries, ships the
 *     published Kim 2010 translation instead.
 *   - SCI: Espie et al., BMJ Open 2014;4:e004183 (© Sleepio Ltd, licensed
 *     free for non-commercial use, CC BY-NC) — 8 items, 0–4 each, total 0–32,
 *     HIGHER = better sleep; "a score of ≤16 … seems reasonable to detect
 *     possible insomnia disorder". Item text is validated in English; app
 *     locales without a validated translation present the English items.
 * This module owns the canonical NUMERIC contract; the human wording lives in
 * `messages/*.json` under `mentalHealth.items.*` (validated translations per
 * locale where they exist — re-wording invalidates the score). See
 * `.planning/research/screening-instruments-2026-07.md`.
 *
 * PHQ-9 item 9 (index 8) is the passive self-harm ideation screen and is the
 * safety-critical field (see `crisis-resources.ts` + the API handler): any
 * non-zero answer triggers a calm, non-alarmist crisis-resource signpost.
 * Neither the WHO-5 (all items positively worded) nor the SCI (sleep-specific
 * items only) carries a crisis item. The raw item answers are NEVER exposed
 * to the Coach / Insights / export surfaces — only the derived total score
 * rides a `*_SCORE` Measurement row.
 */

export type InstrumentId = "PHQ9" | "GAD7" | "WHO5" | "SCI";

export interface InstrumentDefinition {
  id: InstrumentId;
  /** Lowercase i18n slug — the key segment under `mentalHealth.*`. */
  i18nKey: "phq9" | "gad7" | "who5" | "sci";
  /** Number of scored items (PHQ-9 = 9, GAD-7 = 7, WHO-5 = 5, SCI = 8). */
  itemCount: number;
  /** Highest per-item answer value (PHQ/GAD 3, SCI 4, WHO-5 5). */
  itemMax: number;
  /**
   * Answer values in the order the source instrument presents them. The
   * PHQ/GAD forms run 0→3; the WHO-5 form leads with 5 ("All of the time");
   * the SCI form leads with 4.
   */
  optionOrder: readonly number[];
  /**
   * Fully-qualified i18n namespace for the response-option labels: without
   * `optionGroups` one shared anchor set (`<ns>.<value>`); with
   * `optionGroups` (SCI) per-item anchor groups (`<ns>.<group>.<value>`,
   * group = `optionGroups[itemIndex]`). v1.32.36 — qualified rather than
   * relative so the reverse-i18n guard resolves the subtree from the literal
   * instead of being handed the bare `mentalHealth` namespace.
   */
  optionNamespace: string;
  optionGroups?: readonly string[];
  /**
   * Recall-stem caption key per item under `mentalHealth.stems.` — the WHO-5
   * and SCI items are fragments under a shared stem on the source forms, so
   * the wizard paints the applicable stem above the question. PHQ/GAD keep
   * their frame in the instrument description line (shipped contract).
   */
  stemKeys?: readonly string[];
  /** Multiplier from item-sum to the reported total (WHO-5: × 4). */
  scoreMultiplier: number;
  /** Inclusive REPORTED total range (WHO-5: 0–100 percentage). */
  minScore: number;
  maxScore: number;
  /** Whether a HIGHER total is the good direction (WHO-5 / SCI). */
  higherIsBetter: boolean;
  /** Total-score LOINC for the FHIR/export contract; null when none exists. */
  totalLoinc: string | null;
  /** Severity bands, ordered low→high. `min`/`max` inclusive over the total. */
  bands: ReadonlyArray<{ key: string; min: number; max: number }>;
  /**
   * Follow-up threshold on the reported scale. The concerning side follows
   * the direction: PHQ/GAD ≥ threshold, WHO-5/SCI ≤ threshold (WHO-5 "below
   * 50" — 50 itself is unreachable on the ×4 scale; SCI ≤ 16 per Espie 2014).
   */
  actionThreshold: number;
  /** Item index (0-based) of the safety-critical self-harm item, or null. */
  safetyItemIndex: number | null;
  /**
   * Locales whose bundled item wording is a validated translation. A locale
   * outside this list renders the validated source-language items plus an
   * honest chrome note — NEVER a self-made translation.
   */
  validatedItemLocales: readonly string[];
  /**
   * Required attribution — render VERBATIM on the instrument's start card and
   * the result view (and in exports). Stays in English by convention (the
   * developers' names and licence identifiers are not translated).
   */
  attribution: string;
}

const ALL_APP_LOCALES = ["de", "en", "es", "fr", "it", "pl", "ko"] as const;

/**
 * The PHQ family is public-domain (Pfizer 2010); this is the canonical footer
 * text per the instrument's own permission grant.
 */
const PHQ_GAD_ATTRIBUTION =
  "Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and " +
  "colleagues, with an educational grant from Pfizer Inc. No permission " +
  "required to reproduce, translate, display or distribute.";

const PHQ9: InstrumentDefinition = {
  id: "PHQ9",
  i18nKey: "phq9",
  itemCount: 9,
  itemMax: 3,
  optionOrder: [0, 1, 2, 3],
  optionNamespace: "mentalHealth.options",
  scoreMultiplier: 1,
  minScore: 0,
  maxScore: 27,
  higherIsBetter: false,
  totalLoinc: "44261-6",
  bands: [
    { key: "minimal", min: 0, max: 4 },
    { key: "mild", min: 5, max: 9 },
    { key: "moderate", min: 10, max: 14 },
    { key: "modSevere", min: 15, max: 19 },
    { key: "severe", min: 20, max: 27 },
  ],
  actionThreshold: 10,
  // Item 9 ("Thoughts that you would be better off dead…") — the safety field.
  safetyItemIndex: 8,
  validatedItemLocales: ALL_APP_LOCALES,
  attribution: PHQ_GAD_ATTRIBUTION,
};

const GAD7: InstrumentDefinition = {
  id: "GAD7",
  i18nKey: "gad7",
  itemCount: 7,
  itemMax: 3,
  optionOrder: [0, 1, 2, 3],
  optionNamespace: "mentalHealth.options",
  scoreMultiplier: 1,
  minScore: 0,
  maxScore: 21,
  higherIsBetter: false,
  totalLoinc: "70274-6",
  bands: [
    { key: "minimal", min: 0, max: 4 },
    { key: "mild", min: 5, max: 9 },
    { key: "moderate", min: 10, max: 14 },
    { key: "severe", min: 15, max: 21 },
  ],
  actionThreshold: 10,
  safetyItemIndex: null,
  validatedItemLocales: ALL_APP_LOCALES,
  attribution: PHQ_GAD_ATTRIBUTION,
};

/**
 * WHO-5 well-being index — five positively-worded items over the last two
 * weeks, 6-point 5→0 scale. Reported score = raw sum × 4 (0–100, higher =
 * better well-being) per the official WHO scoring. "A percentage score below
 * 50 … has been suggested as a cut-off for poor mental well-being and as an
 * indication for further assessment" (WHO/UCN/MSD/MHE/2024.1) — the result
 * view answers a ≤ 50 total with a gentle pointer to the PHQ-9 check-in.
 * Achievable totals are multiples of 4, so the 0–50 band equals "below 50".
 */
const WHO5: InstrumentDefinition = {
  id: "WHO5",
  i18nKey: "who5",
  itemCount: 5,
  itemMax: 5,
  optionOrder: [5, 4, 3, 2, 1, 0],
  optionNamespace: "mentalHealth.who5Options",
  stemKeys: Array(5).fill("who5.period"),
  scoreMultiplier: 4,
  minScore: 0,
  maxScore: 100,
  higherIsBetter: true,
  totalLoinc: null,
  bands: [
    { key: "low", min: 0, max: 50 },
    { key: "good", min: 51, max: 100 },
  ],
  actionThreshold: 50,
  safetyItemIndex: null,
  // WHO publishes official de/en/es/fr/it/pl versions — all bundled verbatim.
  // There is no Korean one, so `ko` carries the published forward/back-
  // translation from Kim 2010 instead, which is CC BY-NC and so
  // redistributable. Its validation sample was community-dwelling elderly,
  // not general adults — narrower than the other six arms.
  validatedItemLocales: ALL_APP_LOCALES,
  attribution:
    "World Health Organization. The World Health Organization-Five Well-Being " +
    "Index (WHO-5). Geneva: World Health Organization; 2024. Licence: " +
    "CC BY-NC-SA 3.0 IGO. WHO does not endorse this application. Korean " +
    "translation: Kim HJ, Moon YS, Son BK, Lee SK, Rho HJ, Kim DH. J Korean " +
    "Geriatr Psychiatry 2010;14(2):90-96 (CC BY-NC 3.0).",
};

/**
 * Sleep Condition Indicator — eight DSM-5-aligned items, 0–4 each with
 * item-specific anchors, total 0–32, HIGHER = better sleep. "A score of ≤16
 * on the SCI seems reasonable to detect possible insomnia disorder" (Espie
 * et al. 2014) — the band wording stays neutral per the paper, no diagnosis
 * language. Items 1–4 ask about a typical night in the last month, items 5–7
 * about the past month's daytime impact, item 8 about problem duration.
 */
const SCI: InstrumentDefinition = {
  id: "SCI",
  i18nKey: "sci",
  itemCount: 8,
  itemMax: 4,
  optionOrder: [4, 3, 2, 1, 0],
  optionNamespace: "mentalHealth.sciOptions",
  optionGroups: [
    "duration",
    "duration",
    "nights",
    "quality",
    "impact",
    "impact",
    "impact",
    "problemDuration",
  ],
  stemKeys: [
    "sci.night",
    "sci.night",
    "sci.night",
    "sci.night",
    "sci.impact",
    "sci.impact",
    "sci.impact",
    "sci.finally",
  ],
  scoreMultiplier: 1,
  minScore: 0,
  maxScore: 32,
  higherIsBetter: true,
  totalLoinc: null,
  bands: [
    { key: "belowThreshold", min: 0, max: 16 },
    { key: "aboveThreshold", min: 17, max: 32 },
  ],
  actionThreshold: 16,
  safetyItemIndex: null,
  // Validated in English (the CC BY-NC BMJ Open publication). French/Italian
  // validations exist in the literature but their item text is not openly
  // redistributable, so every non-EN locale presents the English items with
  // an honest note — never a self-made translation.
  validatedItemLocales: ["en"],
  attribution:
    "Espie CA, Kyle SD, Hames P, et al. The Sleep Condition Indicator: a " +
    "clinical screening tool to evaluate insomnia disorder. BMJ Open " +
    "2014;4:e004183. © Sleepio Limited; free for non-commercial use (CC BY-NC).",
};

export const INSTRUMENTS: Record<InstrumentId, InstrumentDefinition> = {
  PHQ9,
  GAD7,
  WHO5,
  SCI,
};

/** Landing / history ordering — the shipped pair first, then the new pair. */
export const INSTRUMENT_ORDER: readonly InstrumentId[] = [
  "PHQ9",
  "GAD7",
  "WHO5",
  "SCI",
];

/** The DB MeasurementType the instrument's total score projects to. */
export const INSTRUMENT_MEASUREMENT_TYPE: Record<InstrumentId, string> = {
  PHQ9: "PHQ9_SCORE",
  GAD7: "GAD7_SCORE",
  WHO5: "WHO5_SCORE",
  SCI: "SCI_SCORE",
};

/**
 * The REPORTED total for a completed administration (server-authoritative):
 * item-sum × the instrument's multiplier (WHO-5 reports the 0–100 percentage,
 * everything else the raw sum).
 */
export function scoreTotal(id: InstrumentId, items: readonly number[]): number {
  const sum = items.reduce((acc, v) => acc + v, 0);
  return sum * INSTRUMENTS[id].scoreMultiplier;
}

/** Resolve the severity-band key for a reported total score. */
export function severityBand(id: InstrumentId, total: number): string {
  const def = INSTRUMENTS[id];
  const band = def.bands.find((b) => total >= b.min && total <= b.max);
  // Defensive clamp — the API validates the total is in-range before this runs.
  return band?.key ?? def.bands[def.bands.length - 1].key;
}

/**
 * Whether the gentle follow-up hint applies for a reported total. Direction-
 * aware: PHQ-9/GAD-7 point up (≥ 10), WHO-5 and the SCI point down (≤ 50 /
 * ≤ 16 — lower totals mean lower well-being / worse sleep).
 */
export function needsFollowUp(id: InstrumentId, total: number): boolean {
  const def = INSTRUMENTS[id];
  return def.higherIsBetter
    ? total <= def.actionThreshold
    : total >= def.actionThreshold;
}

/**
 * i18n key (under `mentalHealth.`) for one response option of one item —
 * shared anchors (`options.2`), instrument-specific shared anchors
 * (`who5Options.5`), or the SCI's per-item anchor groups
 * (`sciOptions.duration.4`).
 */
export function optionLabelKey(
  id: InstrumentId,
  itemIndex: number,
  value: number,
): string {
  const def = INSTRUMENTS[id];
  return def.optionGroups
    ? `${def.optionNamespace}.${def.optionGroups[itemIndex]}.${value}`
    : `${def.optionNamespace}.${value}`;
}

/** Stem caption key (under `mentalHealth.stems.`) for an item, or null. */
export function stemKey(id: InstrumentId, itemIndex: number): string | null {
  return INSTRUMENTS[id].stemKeys?.[itemIndex] ?? null;
}

/**
 * Whether the bundled item wording for `locale` is a validated translation.
 * When false the surface shows the validated source-language items plus a
 * localized "validated in English" chrome note.
 */
export function hasValidatedItems(id: InstrumentId, locale: string): boolean {
  const base = locale.toLowerCase().split("-")[0];
  return INSTRUMENTS[id].validatedItemLocales.includes(base);
}

/**
 * Whether the safety signpost must be shown for these answers. True iff the
 * instrument has a safety item and that item was answered with any non-zero
 * value — independent of the total score (item 9 is never gated by the band).
 */
export function isSafetyFlagged(
  id: InstrumentId,
  items: readonly number[],
): boolean {
  const idx = INSTRUMENTS[id].safetyItemIndex;
  if (idx === null) return false;
  return (items[idx] ?? 0) > 0;
}
