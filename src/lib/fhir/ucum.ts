/**
 * The closed set of UCUM expressions HealthLog is allowed to stamp as a coded
 * `Quantity.code`.
 *
 * A FHIR `Quantity` that carries `system: http://unitsofmeasure.org` promises
 * that `code` is a valid UCUM expression a receiver can parse and convert.
 * Copying a display unit into that slot breaks the promise the moment a
 * display string is not UCUM — the registry's `dB[A]` is exactly that case:
 * a readable label for A-weighted decibels, not a UCUM term.
 *
 * So the rule here is the one the lab path already follows: the human-readable
 * `unit` is ALWAYS emitted, and `system` + `code` are added only for a token in
 * this list. An unlisted unit is still conformant — it is just uncoded, which
 * is the honest statement.
 *
 * Membership is asserted, not guessed: every entry is either a UCUM base /
 * derived expression or an annotation (`{…}`, which UCUM defines as a
 * dimensionless comment on the unity `1`). Adding a unit means checking it
 * against the UCUM specification first.
 */

import { UCUM_SYSTEM } from "@/lib/fhir/loinc-map";

/**
 * Validated UCUM expressions. Grouped by where they enter the export so a
 * future signal's unit is checked against the group it belongs to.
 */
const UCUM_ALLOWLIST: ReadonlySet<string> = new Set([
  // Dimensionless + annotations
  "1",
  "%",
  "{score}",
  "{count}",
  "{steps}",
  "{flights}",
  "{falls}",
  // Mass / length / ratio
  "kg",
  "g",
  "mg",
  "ug",
  "cm",
  "m",
  "kg/m2",
  // Time
  "ms",
  "s",
  "min",
  "h",
  "d",
  "a",
  // Rates / speed / energy
  "/min",
  "m/s",
  "kcal",
  "mL",
  "mL/min/kg",
  // Clinical
  "Cel",
  "mm[Hg]",
  "mg/dL",
  "mmol/L",
]);

/**
 * True when `unit` is a UCUM expression this exporter has validated. Anything
 * else — a display label, a locale string, an unchecked new unit — is false,
 * and its Quantity goes out with `unit` alone.
 */
export function isUcumCode(unit: string | null | undefined): boolean {
  return typeof unit === "string" && UCUM_ALLOWLIST.has(unit);
}

/**
 * Build a `Quantity` from a DISPLAY unit — the string the registry or the user
 * supplies, which is only sometimes a UCUM expression. It is emitted as `unit`
 * either way; `system` + `code` follow only when the string validates, and
 * they appear together or not at all (a `system` without a `code` names a code
 * system nothing in the resource uses).
 *
 * The curated paths do NOT go through here: `lab-loinc`'s analyte map and the
 * dose-unit table already resolve a canonical symbol, and that resolution is
 * their validation.
 */
export function ucumQuantity(
  value: number,
  unit: string,
): { value: number; unit: string; system?: string; code?: string } {
  return isUcumCode(unit)
    ? { value, unit, system: UCUM_SYSTEM, code: unit }
    : { value, unit };
}
