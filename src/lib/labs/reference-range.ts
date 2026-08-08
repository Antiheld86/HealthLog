/**
 * v1.18.0 — single source of truth for lab reference-range classification
 * and range-string structure.
 *
 * Three surfaces need the same logic: the API response (`rangeStatus`), the
 * doctor-report PDF table, and the lab list card. They were drifting copies.
 * The CLASSIFICATION (below / in-range / above / unknown) and the range
 * STRUCTURE (`low–high` / `≤ high` / `≥ low` / empty) are shared here; the
 * per-surface NUMBER FORMATTING stays a caller concern — the PDF wants a
 * locale-aware one-decimal formatter, the list trims to int/2-dec — so
 * `formatReferenceRange` takes a `formatNumber` callback and never imposes a
 * formatter of its own.
 */

/**
 * Reference-range classification. Deliberately a three-state, NEUTRAL
 * verdict — the badge that renders it must stay calm and informative, NOT
 * alarming (no red "out of range" tint). `"unknown"` when the lab reported
 * no usable bounds.
 *
 * Bounds are treated as inclusive: a value exactly on the reference limit
 * reads as in-range, matching how labs print "≤" / "≥" reference notation.
 */
export type ReferenceRangeStatus = "in-range" | "below" | "above" | "unknown";

export function classifyReferenceRange(
  value: number,
  referenceLow: number | null | undefined,
  referenceHigh: number | null | undefined,
): ReferenceRangeStatus {
  const hasLow = referenceLow !== null && referenceLow !== undefined;
  const hasHigh = referenceHigh !== null && referenceHigh !== undefined;
  if (!hasLow && !hasHigh) return "unknown";
  if (hasLow && value < (referenceLow as number)) return "below";
  if (hasHigh && value > (referenceHigh as number)) return "above";
  return "in-range";
}

/**
 * Render the reference range as text. Owns only the STRUCTURE — which of the
 * four shapes (`low–high`, `≤ high`, `≥ low`, empty) applies — and defers
 * every digit to the caller-supplied `formatNumber`, so each surface keeps
 * its own number formatting byte-for-byte.
 *
 * `emptyText` is what to return when the lab reported no bounds at all; it
 * defaults to the empty string (the lab list never renders the no-bounds
 * case), while the PDF passes a neutral em-dash placeholder.
 */
export function formatReferenceRange(
  low: number | null | undefined,
  high: number | null | undefined,
  formatNumber: (value: number) => string,
  opts?: { emptyText?: string },
): string {
  const hasLow = low !== null && low !== undefined;
  const hasHigh = high !== null && high !== undefined;
  if (hasLow && hasHigh) {
    return `${formatNumber(low as number)}–${formatNumber(high as number)}`;
  }
  if (hasHigh) return `≤ ${formatNumber(high as number)}`;
  if (hasLow) return `≥ ${formatNumber(low as number)}`;
  return opts?.emptyText ?? "";
}

/**
 * The reference range a lab report printed beside ONE reading, as stored on
 * `LabResult.sourceReference*`.
 */
export interface SourceReferenceRange {
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  sourceReferenceText: string | null;
}

/** Where the bounds a reading is judged against came from. */
export type ReferenceRangeOrigin = "source" | "catalog" | "none";

/** The bounds one reading is judged against, plus how they were arrived at. */
export interface EffectiveReferenceRange {
  /** The bound the verdict uses. */
  low: number | null;
  high: number | null;
  origin: ReferenceRangeOrigin;
  /** The catalog band, kept alongside so a surface can show both. */
  catalogLow: number | null;
  catalogHigh: number | null;
  /** The printed window, kept verbatim. Null when the report stated none. */
  sourceText: string | null;
  /**
   * True when the source window is in force AND the catalog states a window
   * that differs from it. This is the case a reader must be told about: the
   * same number reads differently against the two, so a surface that shows
   * only one of them is showing a partial answer.
   */
  divergesFromCatalog: boolean;
}

/** Two bounds are the same window when both ends match (null included). */
function sameWindow(
  aLow: number | null,
  aHigh: number | null,
  bLow: number | null,
  bHigh: number | null,
): boolean {
  return aLow === bLow && aHigh === bHigh;
}

/**
 * Resolve the reference window ONE reading is judged against.
 *
 * A lab runs its own method on its own device, and the physician reads the
 * value against the window printed on that report. So for a reading that
 * carries a source window, the source window wins — for that reading alone.
 * The catalog band stays the net for every reading that carries none.
 *
 * A source window counts as stating a window only when it yields at least one
 * numeric bound. A printed string with no derivable bound ("negativ", "siehe
 * Befund") is carried through as `sourceText` but never displaces the catalog:
 * a range that could not be read is not an argument for having no range.
 *
 * This function is the ONLY place that precedence is expressed. Every surface
 * that classifies a reading — the API DTO, the doctor report, insights, the
 * coach snapshot, the MCP read, the FHIR export — routes through it, so a
 * reading cannot read as in-range on one surface and out on another.
 */
export function resolveEffectiveReferenceRange(
  catalogLow: number | null | undefined,
  catalogHigh: number | null | undefined,
  source: SourceReferenceRange | null | undefined,
): EffectiveReferenceRange {
  const cLow = catalogLow ?? null;
  const cHigh = catalogHigh ?? null;
  const sLow = source?.sourceReferenceLow ?? null;
  const sHigh = source?.sourceReferenceHigh ?? null;
  const sourceText = source?.sourceReferenceText ?? null;

  if (sLow !== null || sHigh !== null) {
    return {
      low: sLow,
      high: sHigh,
      origin: "source",
      catalogLow: cLow,
      catalogHigh: cHigh,
      sourceText,
      divergesFromCatalog:
        (cLow !== null || cHigh !== null) &&
        !sameWindow(sLow, sHigh, cLow, cHigh),
    };
  }

  return {
    low: cLow,
    high: cHigh,
    origin: cLow !== null || cHigh !== null ? "catalog" : "none",
    catalogLow: cLow,
    catalogHigh: cHigh,
    sourceText,
    divergesFromCatalog: false,
  };
}

/**
 * Classify one reading against its effective window. Qualitative readings
 * (no numeric value) always report `"unknown"` — there is nothing to compare
 * against bounds, and a fabricated verdict is worse than none.
 */
export function classifyAgainstEffectiveRange(
  value: number | null,
  effective: EffectiveReferenceRange,
): ReferenceRangeStatus {
  if (value === null) return "unknown";
  return classifyReferenceRange(value, effective.low, effective.high);
}
