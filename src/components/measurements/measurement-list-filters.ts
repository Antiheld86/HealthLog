/**
 * Pure URL-facet helpers for the measurements management list, following the
 * documents-vault pattern (`vault-utils.ts`): the list's filter state lives in
 * the page URL (`?type&source&from&to&min&max`) so a filtered view is
 * deep-linkable and survives navigation, reload and back/forward. Parsing is
 * lenient — a hand-edited or stale URL drops the invalid facet rather than
 * breaking the page — and serialisation omits defaults so the unfiltered list
 * keeps a bare URL. Kept out of the client component so the round trip stays
 * trivially unit-testable without a render harness.
 */
import { measurementSourceEnum } from "@/lib/validations/measurement";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "./measurement-list-meta";

export interface MeasurementListFilters {
  /** Canonical `MeasurementType`; absent = all types. */
  type?: string;
  /** `MeasurementSource` enum value; absent = all sources. */
  source?: string;
  /** Inclusive day bounds, `YYYY-MM-DD` (the date inputs' committed values). */
  fromDay?: string;
  toDay?: string;
  /** Validated numeric input strings for the value-range pill. */
  valueMin?: string;
  valueMax?: string;
}

const SOURCE_SET = new Set<string>(measurementSourceEnum.options);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dayOrUndefined(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && DAY_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * A value-range bound survives the URL only as a finite number the list's
 * `valueMin`/`valueMax` query params would accept; anything else (including
 * a mid-typing fragment someone pasted) is dropped, not 422'd.
 */
export function numericInputOrUndefined(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 20) return undefined;
  return Number.isFinite(Number(trimmed)) ? trimmed : undefined;
}

/**
 * Parse the list's URL search params (`?type&source&from&to&min&max`) into
 * the filter object. Unknown types/sources are dropped (a stale deep link
 * never traps the user on a broken filter — same contract the old
 * `?type=` seeding had), malformed days and non-numeric bounds likewise.
 */
export function parseMeasurementListSearchParams(
  params: URLSearchParams,
): MeasurementListFilters {
  const filters: MeasurementListFilters = {};

  const type = params.get("type")?.trim();
  if (type && type in MEASUREMENT_TYPE_LABEL_KEYS) filters.type = type;

  const source = params.get("source")?.trim();
  if (source && SOURCE_SET.has(source)) filters.source = source;

  const fromDay = dayOrUndefined(params.get("from"));
  if (fromDay) filters.fromDay = fromDay;

  const toDay = dayOrUndefined(params.get("to"));
  if (toDay) filters.toDay = toDay;

  const valueMin = numericInputOrUndefined(params.get("min"));
  if (valueMin) filters.valueMin = valueMin;

  const valueMax = numericInputOrUndefined(params.get("max"));
  if (valueMax) filters.valueMax = valueMax;

  return filters;
}

/**
 * Serialise the filter object back into the page URL's search string (no
 * leading `?`; empty string for the default view). Inverse of
 * `parseMeasurementListSearchParams` — round-tripping is pinned by test so
 * the `?type=` deep links from the Vorsorge card and the type-badge
 * drill-down stay stable.
 */
export function measurementListFiltersToSearch(
  filters: MeasurementListFilters,
): string {
  const sp = new URLSearchParams();
  if (filters.type) sp.set("type", filters.type);
  if (filters.source) sp.set("source", filters.source);
  if (filters.fromDay) sp.set("from", filters.fromDay);
  if (filters.toDay) sp.set("to", filters.toDay);
  if (filters.valueMin) sp.set("min", filters.valueMin);
  if (filters.valueMax) sp.set("max", filters.valueMax);
  return sp.toString();
}
