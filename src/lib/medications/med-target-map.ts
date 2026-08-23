/**
 * v1.22 (W9, B5) — closed medication-class → target-vital map.
 *
 * The adherence→symptom storyline needs to know which VITAL a medication is
 * meant to move, so the Coach can say "the vital this drug targets drifted",
 * not just "an outcome moved". Today the only drug-class knowledge in the tree
 * is the GLP-1 catalog (`glp1-knowledge.ts`); this generalises that, minimally
 * and conservatively, into a hand-curated class→`MeasurementType[]` table.
 *
 * Design rules (all safety-relevant):
 *  - The table is CLOSED. A medication whose class we cannot confidently infer
 *    maps to `null` — and a null class yields NO storyline. We never guess a
 *    target; a wrong target is a wrong medication claim.
 *  - Only classes with a first-class `MeasurementType` target are listed. Statin
 *    (LDL) and thyroid (TSH) act on LAB analytes that live in `LabResult`, not
 *    the measurement series the storyline reads, so they are deliberately
 *    OUT of scope for v1.22 (documented here, not silently dropped).
 *  - Class inference is whole-token, case-insensitive INN/brand matching plus
 *    the structured `treatmentClass` discriminator + the GLP-1 catalog. No
 *    fuzzy matching — a partial hit is treated as unknown.
 *  - Matching runs on a normalised INN STEM rather than on a language. See
 *    `innStem` below: `Metformin`, `Metformine`, `Metformina`, `Metforminum`
 *    are one molecule under four national conventions, and the needle list
 *    stays one entry long.
 *
 * The storyline that consumes this stays association-only and never advises a
 * dose change; that framing is enforced in the prompt + the B0 eval cases.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { findDrugIdByBrand } from "@/lib/medications/glp1-knowledge";
import { foldLabel } from "@/lib/i18n/localised-label-index";

/** The medication classes the storyline can reason about (closed set). */
export type MedTargetClass = "antihypertensive" | "antidiabetic" | "glp1";

/**
 * Class → the vital(s) the class is prescribed to move. Conservative: every
 * entry is a metric stored as a first-class `MeasurementType` series, so the
 * storyline can read a DAY-bucket mean for it. Statin→LDL and thyroid→TSH are
 * intentionally absent (lab analytes, not measurement series — a follow-on).
 */
export const MED_TARGET_MAP: Readonly<
  Record<MedTargetClass, readonly MeasurementType[]>
> = {
  // Antihypertensives move blood pressure. Systolic leads the storyline
  // (the number users track); diastolic is the secondary target.
  antihypertensive: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
  // Oral/injectable antidiabetics (metformin, sulfonylureas, SGLT2, DPP-4,
  // insulin) move blood glucose.
  antidiabetic: ["BLOOD_GLUCOSE"],
  // GLP-1 / GIP agonists move glucose and weight; both are first-class series.
  glp1: ["BLOOD_GLUCOSE", "WEIGHT"],
} as const;

/** The primary (storyline-leading) target for a class. */
export function primaryTargetForClass(cls: MedTargetClass): MeasurementType {
  return MED_TARGET_MAP[cls][0];
}

/**
 * Whole-token INN needles per class, written ONCE in their English/Latin INN
 * form. Each list is conservative — common generics only — so a name we do not
 * recognise stays unknown (conservative-fail) rather than being mapped to a
 * plausible-but-wrong class. GLP-1 is additionally resolved through the
 * structured brand catalog, not by this list.
 *
 * These are drug names, not app-owned labels: there is no message bundle to
 * derive them from, and adding a locale to `locales` cannot supply them. What
 * makes the next language work is `innStem` — the needle is matched against a
 * spelling-normalised stem, so a national convention costs no entry here.
 */
const ANTIHYPERTENSIVE_NEEDLES: readonly string[] = [
  // ACE inhibitors
  "ramipril",
  "lisinopril",
  "enalapril",
  "perindopril",
  "captopril",
  // ARBs
  "losartan",
  "candesartan",
  "valsartan",
  "irbesartan",
  "telmisartan",
  "olmesartan",
  // calcium-channel blockers
  "amlodipine",
  "nifedipine",
  "lercanidipine",
  "felodipine",
  // beta blockers (BP/HR)
  "bisoprolol",
  "metoprolol",
  "carvedilol",
  "nebivolol",
  "atenolol",
  // diuretics
  "hydrochlorothiazide",
  "indapamide",
  "chlortalidone",
  "furosemide",
  // alpha blockers
  "doxazosin",
];

const ANTIDIABETIC_NEEDLES: readonly string[] = [
  "metformin",
  "insulin",
  "gliclazide",
  "glimepiride",
  "glibenclamide",
  "sitagliptin",
  "linagliptin",
  "saxagliptin",
  "empagliflozin",
  "dapagliflozin",
  "canagliflozin",
  "pioglitazone",
  "repaglinide",
];

const GLP1_INN_NEEDLES: readonly string[] = [
  "semaglutide",
  "tirzepatide",
  "liraglutide",
  "dulaglutide",
  "exenatide",
];

/** Lowercase, trim — the verbatim comparison form the brand lookup wants. */
function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The spelling conventions national INN lists apply to one Latin stem, as a
 * closed rewrite set. Every rule below is an orthographic equivalence, never a
 * similarity heuristic: applied to BOTH the needle and the name, they make the
 * national spellings of ONE molecule converge, and leave two molecules apart.
 *
 *   ch/th/ph  digraphs the Romance and Slavic lists simplify
 *             (chlortalidone / clortalidone, levothyroxine / lewotyroksyna)
 *   x → ks    (doxazosin / doksazosyna)
 *   w → v     (valsartan / walsartan, carvedilol / karwedilol)
 *   y → i     (semaglutide / semaglutyd, ramipril / ramipryl)
 *   z → s     (gliclazide / gliklazyd, lisinopril / lizynopryl)
 *   c → k     (captopril / kaptopril, canagliflozin / kanagliflozyna)
 *   h → ∅     the leftover silent h (hydrochlorothiazide / idroclorotiazide)
 *
 * Order matters: the digraphs resolve before the single letters they contain,
 * and the silent-h drop is last so it cannot eat a digraph's h.
 *
 * A structurally distinct alternative exists and is preferred where the data
 * has it: `Medication.atcCode`. The WHO ATC class prefix is language-free by
 * construction and `resolveMedicationTargets` consults it FIRST. This fold is
 * the fallback for the (common) case of a hand-typed name with no ATC code.
 */
const INN_ORTHOGRAPHY: ReadonlyArray<readonly [RegExp, string]> = [
  [/ch/g, "k"],
  [/th/g, "t"],
  [/ph/g, "f"],
  [/x/g, "ks"],
  [/w/g, "v"],
  [/y/g, "i"],
  [/z/g, "s"],
  [/c/g, "k"],
  [/h/g, ""],
];

/**
 * The grammatical endings national lists attach to the Latin stem — `-um` is
 * the Latin nominative, the bare vowels are the Romance and Slavic forms
 * (metformina / metformine / amlodipino). Only ONE is stripped, and only when
 * a substantial stem is left: shortening a five-letter word to four turns a
 * closed drug list into a source of accidents.
 */
const INN_SUFFIXES: readonly string[] = ["um", "a", "e", "o"];
const INN_MIN_STEM = 6;

/** One already-folded token reduced to its INN stem. */
function innStem(token: string): string {
  let stem = token;
  for (const [pattern, replacement] of INN_ORTHOGRAPHY) {
    stem = stem.replace(pattern, replacement);
  }
  for (const suffix of INN_SUFFIXES) {
    if (stem.endsWith(suffix) && stem.length - suffix.length >= INN_MIN_STEM) {
      return stem.slice(0, -suffix.length);
    }
  }
  return stem;
}

/** A name or a needle as its sequence of INN stems. */
function innTokens(text: string): string[] {
  return foldLabel(text)
    .split("_")
    .filter((token) => token !== "")
    .map(innStem);
}

/** Pre-fold a needle list once — the lists are module constants. */
function stemNeedles(needles: readonly string[]): ReadonlyArray<string[]> {
  return needles.map(innTokens);
}

/**
 * True when `nameTokens` contains `needleTokens` as a contiguous run of WHOLE
 * tokens. A needle that merely appears inside a longer token is not a hit —
 * the conservative-fail rule, unchanged: a German compound such as
 * "Metforminhydrochlorid" stays unknown rather than being guessed at.
 */
function containsTokens(
  nameTokens: readonly string[],
  needleTokens: readonly string[],
): boolean {
  if (needleTokens.length === 0) return false;
  for (let i = 0; i + needleTokens.length <= nameTokens.length; i++) {
    let matched = true;
    for (let j = 0; j < needleTokens.length; j++) {
      if (nameTokens[i + j] !== needleTokens[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** True when any needle in the pre-stemmed list matches the name's tokens. */
function matchesAny(
  nameTokens: readonly string[],
  needles: ReadonlyArray<readonly string[]>,
): boolean {
  return needles.some((needle) => containsTokens(nameTokens, needle));
}

const ANTIHYPERTENSIVE_STEMS = stemNeedles(ANTIHYPERTENSIVE_NEEDLES);
const ANTIDIABETIC_STEMS = stemNeedles(ANTIDIABETIC_NEEDLES);
const GLP1_INN_STEMS = stemNeedles(GLP1_INN_NEEDLES);

/**
 * Infer the target-class of a medication from its structured discriminator,
 * the GLP-1 catalog, and a whole-token INN-stem name match — in that priority
 * order.
 * Returns `null` when the class is not confidently known: the caller then
 * surfaces NO storyline for that medication (conservative-fail, never a guess).
 *
 * `treatmentClass` is the `MedicationCategory` enum on `Medication`
 * (`GENERIC` | `GLP1`). Passing it is optional so a name-only caller still
 * works.
 */
export function inferMedTargetClass(
  name: string,
  treatmentClass?: string | null,
): MedTargetClass | null {
  if (treatmentClass === "GLP1") return "glp1";

  const normalised = normaliseName(name);
  if (!normalised) return null;

  // The structured GLP-1 catalog is authoritative for its brands/INNs. Brands
  // are trade names, not INNs — matched verbatim, never through the stem fold.
  if (findDrugIdByBrand(normalised) !== null) return "glp1";

  const tokens = innTokens(name);
  if (matchesAny(tokens, GLP1_INN_STEMS)) return "glp1";
  if (matchesAny(tokens, ANTIDIABETIC_STEMS)) return "antidiabetic";
  if (matchesAny(tokens, ANTIHYPERTENSIVE_STEMS)) return "antihypertensive";
  return null;
}

// ─── v1.28 efficacy resolver (extends the closed map above) ───────────
//
// The efficacy view ("Wirkung" tab + the Insights summary) needs a target
// resolver that (a) can point at LAB analytes (statin→LDL, thyroid→TSH,
// supplements→their marker) — the documented follow-on the v1.22 map left
// out — and (b) consults the WHO ATC class prefix on `Medication.atcCode`
// before falling back to name inference. It is ADDITIVE: the metric-only
// `MED_TARGET_MAP` / `inferMedTargetClass` / `primaryTargetForClass` above
// stay byte-identical so the adherence-storyline safety path is untouched.
//
// Same discipline as the map above: closed tables, whole-word / fixed-prefix
// matching, conservative-fail to an EMPTY target list (never a guess). The
// clinical association ("this class is prescribed to move this outcome") is
// documented, guideline-cited and vendor-blind in the external knowledge base
// (`medications/drug-class-targets.md`); this code is its mechanical mirror.
// No efficacy claim is encoded here — only what a class is prescribed to move.

/**
 * A resolved target: either a first-class measurement series or a lab analyte.
 * The lab variant carries a `contains`-match needle (matched against a
 * `LabResult.analyte` or the linked `Biomarker.name`, exactly as
 * `getLabHistory` matches) plus a human label for the DTO / UI.
 */
export type MedTarget =
  | { kind: "metric"; measurementType: MeasurementType }
  | { kind: "lab"; analyte: string; label: string };

/**
 * The wider class set the efficacy resolver reasons about: the three
 * metric classes above plus the lab-analyte classes (statin→LDL,
 * thyroid→TSH) and the two supplement markers named in the plan.
 */
export type EfficacyMedClass =
  MedTargetClass | "statin" | "thyroid" | "vitamin_d" | "iron";

/** Class → its ordered target list (primary first). Closed + conservative. */
const EFFICACY_TARGETS: Readonly<
  Record<EfficacyMedClass, readonly MedTarget[]>
> = {
  antihypertensive: [
    { kind: "metric", measurementType: "BLOOD_PRESSURE_SYS" },
    { kind: "metric", measurementType: "BLOOD_PRESSURE_DIA" },
  ],
  antidiabetic: [{ kind: "metric", measurementType: "BLOOD_GLUCOSE" }],
  glp1: [
    { kind: "metric", measurementType: "WEIGHT" },
    { kind: "metric", measurementType: "BLOOD_GLUCOSE" },
  ],
  // Lipid-modifiers (statins et al.) are monitored on LDL — a lab analyte.
  statin: [{ kind: "lab", analyte: "LDL", label: "LDL cholesterol" }],
  // Thyroid therapy is titrated against TSH — a lab analyte.
  thyroid: [{ kind: "lab", analyte: "TSH", label: "TSH" }],
  // Supplements are tracked against their own marker.
  vitamin_d: [
    { kind: "lab", analyte: "Vitamin D", label: "Vitamin D (25-OH)" },
  ],
  iron: [{ kind: "lab", analyte: "Ferritin", label: "Ferritin" }],
} as const;

/**
 * WHO ATC class-prefix → efficacy class. Prefix-level ONLY (the class the
 * substance belongs to), never a specific-product claim. Longer prefixes are
 * tested first so `A10BJ` (GLP-1/GIP agonists) wins over the `A10` fallback.
 * The prefix is upper-cased + validated against the `atcCode` shape before use.
 */
const ATC_PREFIX_CLASS: ReadonlyArray<readonly [string, EfficacyMedClass]> = [
  // Antidiabetics: GLP-1 / GIP agonists move glucose AND weight; the rest of
  // A10 (metformin, sulfonylureas, SGLT2, DPP-4, insulin) move glucose.
  ["A10BJ", "glp1"],
  ["A10", "antidiabetic"],
  // Cardiovascular: antihypertensives (C02 other, C03 diuretics, C07 beta
  // blockers, C08 CCB, C09 ACE/ARB) → blood pressure.
  ["C02", "antihypertensive"],
  ["C03", "antihypertensive"],
  ["C07", "antihypertensive"],
  ["C08", "antihypertensive"],
  ["C09", "antihypertensive"],
  // Lipid-modifying agents → LDL.
  ["C10", "statin"],
  // Thyroid therapy → TSH.
  ["H03A", "thyroid"],
  // Vitamin D / analogues (A11CC) and vitamin-D-only combos (A11CB).
  ["A11CC", "vitamin_d"],
  ["A11CB", "vitamin_d"],
  // Iron preparations (oral B03AA/AB/AD/AE, parenteral B03AC).
  ["B03A", "iron"],
];

const ATC_CODE_RE = /^[A-Z]\d{2}[A-Z]{2}\d{2}$/;

/** Whole-token name needles for the lab classes (metric classes stay above). */
const STATIN_NEEDLES: readonly string[] = [
  "atorvastatin",
  "simvastatin",
  "rosuvastatin",
  "pravastatin",
  "fluvastatin",
  "lovastatin",
  "pitavastatin",
  "ezetimibe",
];
const THYROID_NEEDLES: readonly string[] = [
  "levothyroxine",
  "liothyronine",
  "thyroxine",
  "euthyrox",
];
const VITAMIN_D_NEEDLES: readonly string[] = [
  "cholecalciferol",
  "colecalciferol",
  "ergocalciferol",
  "calcifediol",
  "calcitriol",
];
/**
 * Iron is the one class the INN fold cannot carry, because iron preparations
 * are named for the ELEMENT rather than by an INN: there is no Latin stem for
 * "Eisen" and "Żelazo" to converge on. So this list is hand-tabulated, and a
 * seventh language needs a line added here — the honest exception to the rule
 * the other lists follow. `Medication.atcCode` B03A remains the language-free
 * path and is consulted first.
 *
 * Known limit: the whole-token rule means a German compound ("Eisensulfat")
 * is not a hit, the same way "Metforminhydrochlorid" is not.
 */
const IRON_NEEDLES: readonly string[] = [
  // Salt adjectives (the Latin/English/Romance forms).
  "ferrous",
  "ferroso",
  "ferreux",
  "ferric",
  "bisglycinate",
  // The element, in each shipped language.
  "iron",
  "eisen",
  "fer",
  "hierro",
  "ferro",
  "żelazo",
];

const STATIN_STEMS = stemNeedles(STATIN_NEEDLES);
const THYROID_STEMS = stemNeedles(THYROID_NEEDLES);
const VITAMIN_D_STEMS = stemNeedles(VITAMIN_D_NEEDLES);
const IRON_STEMS = stemNeedles(IRON_NEEDLES);

/**
 * The whole stem vocabulary, per class — the fold's own audit surface.
 *
 * A rewrite rule that made two different molecules collapse onto one stem
 * would map a real drug to the wrong class, silently, and a wrong target is a
 * wrong medication claim. So the vocabulary is exported and a guard asserts
 * that no stem is claimed by two classes and that none is short enough to
 * collide with an ordinary word.
 */
export const MED_NEEDLE_STEMS: Readonly<
  Record<EfficacyMedClass, readonly string[]>
> = {
  antihypertensive: ANTIHYPERTENSIVE_STEMS.map((t) => t.join("_")),
  antidiabetic: ANTIDIABETIC_STEMS.map((t) => t.join("_")),
  glp1: GLP1_INN_STEMS.map((t) => t.join("_")),
  statin: STATIN_STEMS.map((t) => t.join("_")),
  thyroid: THYROID_STEMS.map((t) => t.join("_")),
  vitamin_d: VITAMIN_D_STEMS.map((t) => t.join("_")),
  iron: IRON_STEMS.map((t) => t.join("_")),
};

/** Resolve a med's efficacy class from its ATC prefix, or `null`. */
function classFromAtc(
  atcCode: string | null | undefined,
): EfficacyMedClass | null {
  if (!atcCode) return null;
  const code = atcCode.trim().toUpperCase();
  if (!ATC_CODE_RE.test(code)) return null;
  for (const [prefix, cls] of ATC_PREFIX_CLASS) {
    if (code.startsWith(prefix)) return cls;
  }
  return null;
}

/** Resolve a med's efficacy class from its name (metric + lab needles). */
function classFromName(
  name: string,
  treatmentClass?: string | null,
): EfficacyMedClass | null {
  // Metric classes stay authoritative through the existing inferer.
  const metricClass = inferMedTargetClass(name, treatmentClass);
  if (metricClass) return metricClass;

  const tokens = innTokens(name);
  if (tokens.length === 0) return null;
  if (matchesAny(tokens, STATIN_STEMS)) return "statin";
  if (matchesAny(tokens, THYROID_STEMS)) return "thyroid";
  if (matchesAny(tokens, VITAMIN_D_STEMS)) return "vitamin_d";
  if (matchesAny(tokens, IRON_STEMS)) return "iron";
  return null;
}

/** The tier a target list was resolved through (provenance for the DTO/UI). */
export type MedTargetTier = "atc" | "name";

export interface ResolvedMedTargets {
  cls: EfficacyMedClass;
  tier: MedTargetTier;
  targets: readonly MedTarget[];
}

/**
 * Resolve the derived (non-override) efficacy targets for a medication:
 * ATC class-prefix FIRST (the guideline-native class key), then whole-word
 * name inference. Returns `null` when no class is confidently known — the
 * caller then falls back to the user's own explicit pick (tier 1, persisted)
 * or the "track this against…" chooser. Never guesses a target.
 *
 * Tier 1 (user override) is NOT resolved here — it is persisted and applied by
 * the server efficacy builder, which layers it on top of this derived result.
 */
export function resolveMedicationTargets(med: {
  name: string;
  treatmentClass?: string | null;
  atcCode?: string | null;
}): ResolvedMedTargets | null {
  const viaAtc = classFromAtc(med.atcCode);
  if (viaAtc) {
    return { cls: viaAtc, tier: "atc", targets: EFFICACY_TARGETS[viaAtc] };
  }
  const viaName = classFromName(med.name, med.treatmentClass);
  if (viaName) {
    return { cls: viaName, tier: "name", targets: EFFICACY_TARGETS[viaName] };
  }
  return null;
}

/** The ordered target list for an efficacy class (primary first). */
export function targetsForEfficacyClass(
  cls: EfficacyMedClass,
): readonly MedTarget[] {
  return EFFICACY_TARGETS[cls];
}
