/**
 * v1.32.30 — the profile subsystem's height unit adapter.
 *
 * v1.32.26 wired the metric/imperial preference across every reading
 * surface and v1.32.27 across the target/threshold panels, but both
 * resolve through `display-transform.ts`, which is keyed on
 * `MeasurementType`. Height is not a measurement: it is the profile
 * column `User.heightCm`, written through `PUT /api/auth/profile`. That
 * is why it stayed in centimetres while everything else followed the
 * preference. This module is the missing adapter.
 *
 * Storage and the wire never change. `User.heightCm`, the Zod bound in
 * `src/lib/validations/auth.ts` (50-300 cm), the OpenAPI contract, the
 * BMI math, the weight bands, the doctor report, and the AI snapshot all
 * stay canonical centimetres. The adapter converts at the render
 * boundary and inverts at the entry boundary, exactly like the target
 * adapter does for a threshold.
 *
 * Imperial entry is feet PLUS inches, not decimal inches, because that
 * is how a person states their height. The draft therefore carries
 * three string slots and the active branch decides which ones it fills.
 *
 * The three rules that make the round-trip safe:
 *
 *   1. The imperial branch quantises to WHOLE inches at the entry
 *      boundary. `n` whole inches is exactly `n * 2.54` cm, a value that
 *      needs at most two decimals, so rounding the canonical result to
 *      two decimals is lossless and `cm / 2.54` lands back on `n`.
 *      5 ft 11 in becomes 71 in becomes 180.34 cm becomes 71 in again.
 *   2. Guardrails round INWARD, the same way the target adapter rounds
 *      a threshold bound. Inches always span a full foot, so the FEET
 *      window is the part that shrinks: its floor is ceiled and its
 *      ceiling is floored against the worst case of 11 extra inches.
 *      Every feet/inches pair the fields offer therefore inverts to a
 *      centimetre value inside the window the server enforces.
 *   3. The metric branch is the exact identity. The draft seeds from
 *      `String(cm)` and returns `Number.parseFloat` of what was typed,
 *      with no rounding and no re-derivation, so a metric account's
 *      stored height is bit-for-bit unchanged by this release.
 *
 * A height first entered in centimetres and then read on the imperial
 * branch snaps to the nearest whole inch (180 cm reads as 5 ft 11 in)
 * and re-canonicalises to 180.34 cm on the next save. That single snap
 * is inherent to changing the entry granularity; every save after it is
 * stable.
 */
import type { UnitPreference } from "@/lib/measurements/display-transform";

/** Canonical guardrails - mirrors the Zod bound the server enforces. */
const MIN_CM = 50;
const MAX_CM = 300;

const CM_PER_INCH = 2.54;
const INCHES_PER_FOOT = 12;

/** Decimals a converted height persists with (the entry-form dialect). */
const CANONICAL_DECIMALS = 2;

/** Inward-rounded imperial equivalents of the canonical window. */
const MIN_TOTAL_INCHES = Math.ceil(MIN_CM / CM_PER_INCH);
const MAX_TOTAL_INCHES = Math.floor(MAX_CM / CM_PER_INCH);

/**
 * The feet window, shrunk so that every inches value it can be paired
 * with still lands inside the canonical window: the floor assumes 0
 * extra inches, the ceiling assumes the full 11.
 */
const MIN_FEET = Math.ceil(MIN_TOTAL_INCHES / INCHES_PER_FOOT);
const MAX_FEET = Math.floor(
  (MAX_TOTAL_INCHES - (INCHES_PER_FOOT - 1)) / INCHES_PER_FOOT,
);

/**
 * The three entry slots a height form holds. Both branches keep the
 * same shape so flipping the preference never reshapes form state and
 * the seeded-form dirty check stays comparable. The inactive branch's
 * slots stay "".
 */
export interface HeightDraft {
  /** Centimetres, as typed. Metric branch only. */
  cm: string;
  /** Whole feet, as typed. Imperial branch only. */
  feet: string;
  /** Inches within the foot, as typed. Imperial branch only. */
  inches: string;
}

/** The blank draft - no height set, on either branch. */
export const EMPTY_HEIGHT_DRAFT: HeightDraft = { cm: "", feet: "", inches: "" };

interface NumericBounds {
  min: number;
  max: number;
}

/**
 * Client-side input limits in the ENTRY unit. Shared by both branches
 * because a form only renders the slots its branch uses.
 */
const ENTRY_BOUNDS = {
  cm: { min: MIN_CM, max: MAX_CM },
  feet: { min: MIN_FEET, max: MAX_FEET },
  inches: { min: 0, max: INCHES_PER_FOOT - 1 },
} as const satisfies Record<string, NumericBounds>;

export interface HeightUnitAdapter {
  /** The resolved preference this adapter was built for. */
  preference: UnitPreference;
  /** True when the surface renders the two-part feet + inches row. */
  usesFeetInches: boolean;
  /** Stored centimetres to the draft the entry fields seed from. */
  toDraft(cm: number | null | undefined): HeightDraft;
  /**
   * Entry draft to the canonical centimetres the API receives. Returns
   * null for a blank or unparseable draft, which is the "no height"
   * value the profile route accepts.
   */
  toCanonicalCm(draft: HeightDraft): number | null;
  /** Input limits for the slots this branch renders. */
  bounds: typeof ENTRY_BOUNDS;
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/** Whole inches to canonical centimetres. */
function totalInchesToCm(totalInches: number): number {
  return roundTo(totalInches * CM_PER_INCH, CANONICAL_DECIMALS);
}

/** Canonical centimetres to the nearest whole inch. */
function cmToTotalInches(cm: number): number {
  return Math.round(cm / CM_PER_INCH);
}

/**
 * Parse one draft slot. Blank reads as 0 so "5 ft" with an untouched
 * inches box is 60 in; anything unparseable reads as null so the caller
 * refuses the whole draft rather than persisting a half-typed number.
 */
function parseSlot(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

const METRIC_ADAPTER: HeightUnitAdapter = {
  preference: "metric",
  usesFeetInches: false,
  toDraft: (cm) =>
    cm == null || !Number.isFinite(cm)
      ? EMPTY_HEIGHT_DRAFT
      : { cm: String(cm), feet: "", inches: "" },
  toCanonicalCm: (draft) => {
    if (draft.cm.trim() === "") return null;
    const parsed = Number.parseFloat(draft.cm);
    return Number.isFinite(parsed) ? parsed : null;
  },
  bounds: ENTRY_BOUNDS,
};

const IMPERIAL_ADAPTER: HeightUnitAdapter = {
  preference: "imperial",
  usesFeetInches: true,
  toDraft: (cm) => {
    if (cm == null || !Number.isFinite(cm)) return EMPTY_HEIGHT_DRAFT;
    const totalInches = cmToTotalInches(cm);
    return {
      cm: "",
      feet: String(Math.floor(totalInches / INCHES_PER_FOOT)),
      inches: String(totalInches % INCHES_PER_FOOT),
    };
  },
  toCanonicalCm: (draft) => {
    if (draft.feet.trim() === "" && draft.inches.trim() === "") return null;
    const feet = parseSlot(draft.feet);
    const inches = parseSlot(draft.inches);
    if (feet === null || inches === null) return null;
    // Quantise to whole inches so save-then-reopen returns the typed
    // feet + inches pair instead of drifting by a fraction (rule 1).
    return totalInchesToCm(Math.round(feet * INCHES_PER_FOOT + inches));
  },
  bounds: ENTRY_BOUNDS,
};

/** Resolve the height entry adapter for the user's unit preference. */
export function resolveHeightUnitAdapter(
  preference: UnitPreference,
): HeightUnitAdapter {
  return preference === "imperial" ? IMPERIAL_ADAPTER : METRIC_ADAPTER;
}
