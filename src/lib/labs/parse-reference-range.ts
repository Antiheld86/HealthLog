/**
 * Free-text reference-range parser for the range a lab report prints beside a
 * value.
 *
 * A report states its window in prose, not in columns: "3,5 - 5,0", "< 5",
 * "bis 5,0", "≥ 3,5", "150.000 - 400.000 /µl", or a word like "negativ" that
 * carries no window at all. The document-reading path and the manual entry
 * form both hand that string here.
 *
 * The contract is deliberately asymmetric:
 *
 *  - KEEPING the printed string is mandatory. `text` always carries what the
 *    report said, whitespace-normalised and length-capped, whether or not a
 *    bound could be derived from it. A window this parser cannot read is not
 *    a window that gets thrown away.
 *  - DERIVING bounds is best-effort and refuses on ambiguity. A string that
 *    does not match one of the notations below yields `low: null, high: null`
 *    beside the text. Absence reads as absence — the parser never picks a
 *    plausible bound out of a string it did not understand, because a fake
 *    window silently reclassifies a reading as normal or abnormal.
 *
 * Notations read (German and English, comma- or dot-decimal):
 *
 *   two-sided   3.5-5.0 · 3,5 – 5,0 · 3,5 bis 5,0 · 3.5 to 5.0 · 3,5 ... 5,0
 *               von 3,5 bis 5,0 · [3,5 - 5,0] · (3.5-5.0)
 *   upper only  < 5 · ≤ 5 · <= 5 · bis 5,0 · bis zu 5,0 · max. 5,0 ·
 *               kleiner 5 · unter 5 · up to 5.0 · less than 5
 *   lower only  > 3.5 · ≥ 3,5 · >= 3.5 · ab 3,5 · min. 3,5 · mindestens 3,5 ·
 *               größer 3,5 · über 3,5 · at least 3.5
 *
 * Units are read, never converted. A window may carry the unit the report
 * printed it in; when the caller states the reading's own unit and the two
 * disagree, the bounds are refused and only the text survives. Converting
 * mmol/L into mg/dL needs a per-analyte factor, so doing it here would be the
 * parser deciding what the report meant.
 */

/** What a printed range yielded. `text` is set whenever the input was non-empty. */
export interface ParsedReferenceRange {
  /** Lower bound, or null when the notation states none / could not be read. */
  low: number | null;
  /** Upper bound, or null when the notation states none / could not be read. */
  high: number | null;
  /** The printed string, whitespace-normalised and capped. Never null here. */
  text: string;
}

/**
 * Storage cap for the verbatim string. A reference-range cell is a few
 * characters; anything longer is a mis-segmented paragraph, and truncating it
 * keeps a runaway transcription out of the column.
 */
export const SOURCE_REFERENCE_TEXT_MAX = 120;

/** Magnitude ceiling. Beyond this a "bound" is a transcription artefact. */
const MAX_ABS_BOUND = 1e12;

/** One number token: optional sign, digits, any number of `.`/`,` groups. */
const NUM = String.raw`[+-]?\d+(?:[.,]\d+)*`;

/** Infix separators for a two-sided window. */
const TWO_SIDED_SEP = String.raw`(?:-|–|—|‒|…|\.{2,3}|bis\s+zu|bis|to|until)`;

/** Prefixes that state a ceiling only. */
const UPPER_PREFIX = String.raw`(?:<=|<|≤|bis\s+zu|bis|max\.|maximal|max|kleiner\s+als|kleiner|unter|höchstens|hoechstens|up\s+to|less\s+than|below)`;

/** Prefixes that state a floor only. */
const LOWER_PREFIX = String.raw`(?:>=|>|≥|ab|mind\.|mindestens|minimal|min\.|min|größer\s+als|größer|groesser\s+als|groesser|über|ueber|at\s+least|greater\s+than|above)`;

/**
 * Trailing unit tail. Deliberately whitespace-free and comma-free: a real unit
 * symbol ("mmol/l", "mg/dL", "%", "/µl", "10^9/L") never contains either, and
 * refusing anything that does keeps a third number ("3,5 - 5,0 - 7,0") from
 * being swallowed as if it were a unit.
 */
const UNIT_TAIL = String.raw`(?:\s*([^\s,]{1,24}))?`;

const TWO_SIDED_RE = new RegExp(
  `^(${NUM})\\s*${TWO_SIDED_SEP}\\s*(${NUM})${UNIT_TAIL}$`,
  "iu",
);
const UPPER_RE = new RegExp(`^${UPPER_PREFIX}\\s*(${NUM})${UNIT_TAIL}$`, "iu");
const LOWER_RE = new RegExp(`^${LOWER_PREFIX}\\s*(${NUM})${UNIT_TAIL}$`, "iu");

/** Leading words that only introduce the window ("von 3,5 bis 5,0"). */
const LEADING_FILLER_RE = /^(?:von|from|ref\.?|referenz|reference)\s+/iu;

/**
 * Read one number token into a JS number, or null when its separators are
 * ambiguous.
 *
 * Separator rules, in order:
 *   1. Both `.` and `,` present → the LAST one is the decimal mark, the other
 *      groups thousands ("1.234,56" and "1,234.56" both read as 1234.56).
 *   2. One separator kind, appearing more than once → all thousands
 *      ("1.234.567").
 *   3. One separator, appearing once, group ≠ 3 digits → decimal ("3,5").
 *   4. One separator, appearing once, group = 3 digits → ambiguous in the
 *      general case. Read as thousands only when the group is "000", which is
 *      how a German report prints a rounded count ("150.000 - 400.000 /µl");
 *      reading that as 150 would flag every normal platelet count as wildly
 *      high. Any other 3-digit group ("1.234" — 1234 or 1.234?) is refused.
 *
 * The limit of rule 4 is real: a report that prints "5.000" meaning five with
 * three decimal places is read as five thousand. The verbatim text is stored
 * either way, so the printed window is never lost — only the derived bound is.
 */
function readNumber(token: string): number | null {
  const sign = token.startsWith("-") ? -1 : 1;
  const body = token.replace(/^[+-]/u, "");

  const dots = (body.match(/\./gu) ?? []).length;
  const commas = (body.match(/,/gu) ?? []).length;

  let normalised: string;
  if (dots > 0 && commas > 0) {
    const decimalMark =
      body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ",";
    const grouping = decimalMark === "." ? "," : ".";
    normalised = body.split(grouping).join("").replace(decimalMark, ".");
  } else if (dots + commas === 0) {
    normalised = body;
  } else if (dots > 1 || commas > 1) {
    normalised = body.replace(/[.,]/gu, "");
  } else {
    const idx = body.search(/[.,]/u);
    const group = body.slice(idx + 1);
    if (group.length !== 3) {
      normalised = `${body.slice(0, idx)}.${group}`;
    } else if (group === "000") {
      normalised = body.slice(0, idx) + group;
    } else {
      return null;
    }
  }

  const value = sign * Number(normalised);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_BOUND) return null;
  return value;
}

/** Compare a printed unit against the reading's unit, ignoring case + spaces. */
function unitsAgree(printed: string | undefined, reading: string | undefined) {
  if (!printed) return true;
  if (!reading || !reading.trim()) return true;
  const norm = (u: string) => u.replace(/\s+/gu, "").toLowerCase();
  return norm(printed) === norm(reading);
}

/**
 * Parse the reference range a lab report printed for one reading.
 *
 * @param raw   the printed string, exactly as transcribed.
 * @param unit  the reading's own unit, when known. A printed window in a
 *              different unit yields text-only — never a converted bound.
 * @returns null when there was nothing printed at all.
 */
export function parseReferenceRange(
  raw: string | null | undefined,
  unit?: string | null,
): ParsedReferenceRange | null {
  if (raw === null || raw === undefined) return null;
  const text = raw
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, SOURCE_REFERENCE_TEXT_MAX);
  if (text === "") return null;

  const noBounds: ParsedReferenceRange = { low: null, high: null, text };

  // Strip a bracket wrapper and an introducing word for MATCHING only — the
  // stored text stays exactly what the report printed.
  let candidate = text;
  const bracketed = /^[[(](.*)[\])]$/u.exec(candidate);
  if (bracketed) candidate = bracketed[1].trim();
  candidate = candidate.replace(LEADING_FILLER_RE, "").trim();

  const two = TWO_SIDED_RE.exec(candidate);
  if (two) {
    if (!unitsAgree(two[3], unit ?? undefined)) return noBounds;
    const low = readNumber(two[1]);
    const high = readNumber(two[2]);
    if (low === null || high === null) return noBounds;
    // A transposed window is a transcription error, and swapping it would be a
    // guess about which digit the lab meant. Refuse the bounds, keep the text.
    if (low > high) return noBounds;
    return { low, high, text };
  }

  const upper = UPPER_RE.exec(candidate);
  if (upper) {
    if (!unitsAgree(upper[2], unit ?? undefined)) return noBounds;
    const high = readNumber(upper[1]);
    return high === null ? noBounds : { low: null, high, text };
  }

  const lower = LOWER_RE.exec(candidate);
  if (lower) {
    if (!unitsAgree(lower[2], unit ?? undefined)) return noBounds;
    const low = readNumber(lower[1]);
    return low === null ? noBounds : { low, high: null, text };
  }

  // Anything else — "negativ", "siehe Befund", a bare number, prose — keeps its
  // text and states no window.
  return noBounds;
}
