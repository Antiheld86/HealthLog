/**
 * Nutrient catalog — the closed code set for the micronutrient-intake
 * sync (v1.28).
 *
 * 26 codes: the 24 HealthKit `Dietary*` vitamin/mineral quantity types
 * plus DietaryWater and DietaryCaffeine. Energy, carbohydrates,
 * protein, fat, sugar, fiber AND sodium/potassium are deliberately NOT
 * here — the anti-goal against diet-app territory stands, and
 * sodium/potassium are food-composition signals, not "substances
 * taken" (maintainer decision, out until explicit user demand).
 *
 * This catalog is the single source of truth for:
 *   - the closed `nutrient` code enum on the wire and in storage;
 *   - the canonical storage unit per code, which is ALSO the pinned
 *     HealthKit query unit for iOS (mass types in mg or µg as listed,
 *     water in mL — never IU). The batch route rejects any entry whose
 *     echoed `unit` differs, because a silent µg/mg confusion is a
 *     1000× corruption and the one-string echo is the cheapest guard;
 *   - the generous per-day plausibility cap (ingest guard against
 *     unit-confused or corrupted writers, NOT a health judgement —
 *     values above high-dose supplement reality get skipped);
 *   - the EFSA dietary reference values a later Coach block compares
 *     against. Every reference names its EFSA value kind (PRI /
 *     AI / safeLevel) and a direction: `target` for reference intakes,
 *     `upperGuidance` for caffeine's safe-level ceiling. Sex-split
 *     values resolve against the user profile at consumption time —
 *     a profile without sex omits the reference, never guesses.
 *
 * Reference values are the EFSA DRV Finder adult values (Dietary
 * Reference Values for the EU population); each entry cites its source
 * verbatim in `reference.source`. Where EFSA expresses a vitamin per
 * energy unit (thiamin, niacin), the entry carries the value at the
 * 10 MJ/day reference energy intake and says so in the citation.
 * Chromium is the one exception: EFSA concluded no DRV can be set, so
 * the entry cites the NIH ODS adequate intake instead — spelled out in
 * its source string.
 */

import type { BinaryReferenceSex } from "@/lib/profile/sex";

export const NUTRIENT_CODES = [
  // 13 vitamins
  "vitamin_a",
  "thiamin",
  "riboflavin",
  "niacin",
  "pantothenic_acid",
  "vitamin_b6",
  "biotin",
  "folate",
  "vitamin_b12",
  "vitamin_c",
  "vitamin_d",
  "vitamin_e",
  "vitamin_k",
  // 11 minerals (sodium + potassium excluded by directive)
  "calcium",
  "iron",
  "magnesium",
  "phosphorus",
  "zinc",
  "copper",
  "manganese",
  "selenium",
  "chromium",
  "molybdenum",
  "iodine",
  // taken substances with correlation value
  "water",
  "caffeine",
] as const;

export type NutrientCode = (typeof NUTRIENT_CODES)[number];

/** Canonical storage units. `ug` is µg on the wire — ASCII on purpose. */
export type NutrientUnit = "mg" | "ug" | "ml";

export interface NutrientReference {
  /** EFSA value type, named in Coach prose later (Slice B). */
  kind: "PRI" | "AI" | "safeLevel";
  /** `target` = reference intake; `upperGuidance` = do-not-exceed. */
  direction: "target" | "upperGuidance";
  /** Uniform adult value where the source is uniform. */
  adult?: number;
  /** Sex-split values where the source splits (e.g. iron 11 / 16). */
  male?: number;
  female?: number;
  /** Citation, quoted verbatim wherever the reference surfaces. */
  source: string;
}

export interface NutrientDefinition {
  code: NutrientCode;
  /** HealthKit quantity type identifier iOS reads this code from. */
  hkIdentifier: string;
  /** Canonical storage unit AND the pinned HK query unit. */
  unit: NutrientUnit;
  /** i18n key for the display name (settings card + exports). */
  labelKey: string;
  /**
   * Generous per-day ingest cap in the canonical unit. Entries above it
   * are skipped `value_out_of_range` — sized well above high-dose
   * supplement reality so only unit confusion / corruption trips it.
   */
  plausibleDailyMax: number;
  reference: NutrientReference;
}

function def(
  code: NutrientCode,
  hkSuffix: string,
  unit: NutrientUnit,
  plausibleDailyMax: number,
  reference: NutrientReference,
): NutrientDefinition {
  return {
    code,
    hkIdentifier: `HKQuantityTypeIdentifierDietary${hkSuffix}`,
    unit,
    labelKey: `nutrients.names.${code}`,
    plausibleDailyMax,
    reference,
  };
}

export const NUTRIENT_CATALOG: Readonly<
  Record<NutrientCode, NutrientDefinition>
> = Object.freeze({
  // ── Vitamins ─────────────────────────────────────────────────────
  vitamin_a: def("vitamin_a", "VitaminA", "ug", 15000, {
    kind: "PRI",
    direction: "target",
    male: 750,
    female: 650,
    source: "EFSA DRV 2015 (retinol equivalents, adults)",
  }),
  // The cap is 500, not the 1000 the other B-vitamins carry, because thiamin's
  // PRI is exactly 1.0 mg: a µg-read-as-mg sample lands on exactly 1000, and
  // the ingest guard compares with `>`, so a 1000× error slipped through at
  // precisely this one analyte. 500 still clears any real supplement dose
  // (high-dose thiamin tops out around 300 mg) while catching that collision.
  thiamin: def("thiamin", "Thiamin", "mg", 500, {
    kind: "PRI",
    direction: "target",
    adult: 1.0,
    source: "EFSA DRV 2016 (PRI 0.1 mg/MJ ≈ 1.0 mg/d at 10 MJ/d)",
  }),
  riboflavin: def("riboflavin", "Riboflavin", "mg", 1000, {
    kind: "PRI",
    direction: "target",
    adult: 1.6,
    source: "EFSA DRV 2017 (adults)",
  }),
  niacin: def("niacin", "Niacin", "mg", 3000, {
    kind: "PRI",
    direction: "target",
    adult: 16,
    source: "EFSA DRV 2014 (PRI 1.6 mg NE/MJ ≈ 16 mg NE/d at 10 MJ/d)",
  }),
  pantothenic_acid: def("pantothenic_acid", "PantothenicAcid", "mg", 2000, {
    kind: "AI",
    direction: "target",
    adult: 5,
    source: "EFSA DRV 2014 (adults)",
  }),
  vitamin_b6: def("vitamin_b6", "VitaminB6", "mg", 1000, {
    kind: "PRI",
    direction: "target",
    male: 1.7,
    female: 1.6,
    source: "EFSA DRV 2016 (adults)",
  }),
  biotin: def("biotin", "Biotin", "ug", 20000, {
    kind: "AI",
    direction: "target",
    adult: 40,
    source: "EFSA DRV 2014 (adults)",
  }),
  folate: def("folate", "Folate", "ug", 5000, {
    kind: "PRI",
    direction: "target",
    adult: 330,
    source: "EFSA DRV 2014 (dietary folate equivalents, adults)",
  }),
  vitamin_b12: def("vitamin_b12", "VitaminB12", "ug", 5000, {
    kind: "AI",
    direction: "target",
    adult: 4,
    source: "EFSA DRV 2015 (cobalamin, adults)",
  }),
  vitamin_c: def("vitamin_c", "VitaminC", "mg", 10000, {
    kind: "PRI",
    direction: "target",
    male: 110,
    female: 95,
    source: "EFSA DRV 2013 (adults)",
  }),
  vitamin_d: def("vitamin_d", "VitaminD", "ug", 1000, {
    kind: "AI",
    direction: "target",
    adult: 15,
    source: "EFSA DRV 2016 (adults, assuming minimal cutaneous synthesis)",
  }),
  vitamin_e: def("vitamin_e", "VitaminE", "mg", 2000, {
    kind: "AI",
    direction: "target",
    male: 13,
    female: 11,
    source: "EFSA DRV 2015 (alpha-tocopherol, adults)",
  }),
  vitamin_k: def("vitamin_k", "VitaminK", "ug", 10000, {
    kind: "AI",
    direction: "target",
    adult: 70,
    source: "EFSA DRV 2017 (phylloquinone, adults)",
  }),
  // ── Minerals ─────────────────────────────────────────────────────
  calcium: def("calcium", "Calcium", "mg", 5000, {
    kind: "PRI",
    direction: "target",
    adult: 950,
    source: "EFSA DRV 2015 (adults ≥ 25 y)",
  }),
  iron: def("iron", "Iron", "mg", 500, {
    kind: "PRI",
    direction: "target",
    male: 11,
    female: 16,
    source: "EFSA DRV 2015 (adults; 16 mg premenopausal women)",
  }),
  magnesium: def("magnesium", "Magnesium", "mg", 2000, {
    kind: "AI",
    direction: "target",
    male: 350,
    female: 300,
    source: "EFSA DRV 2015 (adults)",
  }),
  phosphorus: def("phosphorus", "Phosphorus", "mg", 5000, {
    kind: "AI",
    direction: "target",
    adult: 550,
    source: "EFSA DRV 2015 (adults)",
  }),
  zinc: def("zinc", "Zinc", "mg", 200, {
    kind: "PRI",
    direction: "target",
    male: 9.4,
    female: 7.5,
    source: "EFSA DRV 2014 (adults, at 300 mg/d phytate intake)",
  }),
  copper: def("copper", "Copper", "mg", 20, {
    kind: "AI",
    direction: "target",
    male: 1.6,
    female: 1.3,
    source: "EFSA DRV 2015 (adults)",
  }),
  manganese: def("manganese", "Manganese", "mg", 50, {
    kind: "AI",
    direction: "target",
    adult: 3,
    source: "EFSA DRV 2013 (adults)",
  }),
  selenium: def("selenium", "Selenium", "ug", 1000, {
    kind: "AI",
    direction: "target",
    adult: 70,
    source: "EFSA DRV 2014 (adults)",
  }),
  chromium: def("chromium", "Chromium", "ug", 2000, {
    kind: "AI",
    direction: "target",
    male: 35,
    female: 25,
    source: "NIH ODS 2018 (adults 19–50 y; EFSA 2014 sets no DRV for chromium)",
  }),
  molybdenum: def("molybdenum", "Molybdenum", "ug", 2000, {
    kind: "AI",
    direction: "target",
    adult: 65,
    source: "EFSA DRV 2013 (adults)",
  }),
  iodine: def("iodine", "Iodine", "ug", 2000, {
    kind: "AI",
    direction: "target",
    adult: 150,
    source: "EFSA DRV 2014 (adults)",
  }),
  // ── Taken substances with correlation value ──────────────────────
  water: def("water", "Water", "ml", 20000, {
    kind: "AI",
    direction: "target",
    male: 2500,
    female: 2000,
    source: "EFSA DRV 2010 (total water incl. food moisture, adults)",
  }),
  caffeine: def("caffeine", "Caffeine", "mg", 2000, {
    kind: "safeLevel",
    direction: "upperGuidance",
    adult: 400,
    source: "EFSA 2015 scientific opinion on the safety of caffeine (adults)",
  }),
});

/** Catalog rows in canonical display order (the tuple order above). */
export const NUTRIENT_DEFINITIONS: ReadonlyArray<NutrientDefinition> =
  NUTRIENT_CODES.map((code) => NUTRIENT_CATALOG[code]);

const NUTRIENT_CODE_SET: ReadonlySet<string> = new Set(NUTRIENT_CODES);

/** True when `code` is a known catalog code. */
export function isNutrientCode(code: string): code is NutrientCode {
  return NUTRIENT_CODE_SET.has(code);
}

/** A catalog reference resolved to one concrete number for a profile. */
export interface ResolvedNutrientReference {
  kind: NutrientReference["kind"];
  direction: NutrientReference["direction"];
  value: number;
  source: string;
}

/**
 * Resolve a catalog reference against the user's profile sex (v1.29).
 *
 * `adult` values (uniform across sexes) resolve unconditionally. A
 * sex-split reference (`male` / `female`, no `adult`) resolves only
 * when `sex` is known — a profile without sex on file OMITS the
 * reference rather than guessing, the catalog's own documented
 * contract (see the module docblock). Every insights surface honours
 * this: no reference line, no meta sentence, nothing inferred.
 */
export function resolveNutrientReference(
  code: NutrientCode,
  sex: BinaryReferenceSex | null,
): ResolvedNutrientReference | null {
  const ref = NUTRIENT_CATALOG[code].reference;
  const value =
    ref.adult ??
    (sex === "MALE" ? ref.male : sex === "FEMALE" ? ref.female : undefined);
  if (value === undefined) return null;
  return {
    kind: ref.kind,
    direction: ref.direction,
    value,
    source: ref.source,
  };
}
