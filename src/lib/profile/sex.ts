/**
 * The one owner of the profile sex value: what the column holds, and the
 * single place where it is allowed to shrink.
 *
 * `User.gender` stores three values plus "no answer". Several surfaces used
 * to type it as two, either by narrowing early or by an `as` cast, and the
 * third value then travelled through code that could not represent it. That
 * is how it ends up defaulting into whichever branch happens to be last:
 * the FHIR export mapped it to `female`, and the Strain model scored it on
 * the male coefficients. Both were the same defect wearing different clothes.
 *
 * So: carry the stored value as far as it can honestly go, and narrow only
 * at the boundary of a reference table that genuinely has no third row —
 * through `binaryReferenceSex`, which is named so the shrink is visible in
 * a diff instead of hiding inside a ternary.
 *
 * Client-safe — a type and a pure function, no imports.
 */

/** Profile sex exactly as stored; `null` = the account gave no answer. */
export type ProfileSex = "MALE" | "FEMALE" | "OTHER" | null;

/**
 * The two values a sex-split reference table actually has rows for. Named so
 * a table's signature can say what it needs without re-listing the pair, and
 * so the list has exactly one place to change.
 */
export type BinaryReferenceSex = "MALE" | "FEMALE";

/**
 * Narrow a stored sex to the two values a sex-split reference table has
 * rows for. `OTHER` and "no answer" both resolve to `null`, and every
 * consumer of that `null` answers with a neutral value or with nothing —
 * never with one of the two sides. Accepts a loose `string` because a few
 * callers read the column straight off Prisma, where it is `String?`.
 */
export function binaryReferenceSex(
  sex: string | null | undefined,
): BinaryReferenceSex | null {
  return sex === "MALE" || sex === "FEMALE" ? sex : null;
}

/** Narrow an arbitrary stored string to the three values the column holds. */
export function toProfileSex(sex: string | null | undefined): ProfileSex {
  return sex === "MALE" || sex === "FEMALE" || sex === "OTHER" ? sex : null;
}
