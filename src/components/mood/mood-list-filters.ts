/**
 * Pure URL-facet helpers for the mood management list, following the
 * documents-vault pattern (`vault-utils.ts`): the list's filter state lives
 * in the page URL (`?mood&source&from&to`) so a filtered view is
 * deep-linkable and survives navigation, reload and back/forward. Parsing is
 * lenient — a hand-edited or stale URL drops the invalid facet rather than
 * breaking the page — and serialisation omits defaults so the unfiltered
 * list keeps a bare URL. Kept out of the client component so the round trip
 * stays trivially unit-testable without a render harness.
 */
import { moodLevelEnum, moodSourceEnum } from "@/lib/validations/mood";

export interface MoodListFilters {
  /** `MoodLevel` enum value; absent = all moods. */
  mood?: string;
  /** `MoodSource` enum value; absent = all sources. */
  source?: string;
  /** Inclusive day bounds, `YYYY-MM-DD` (the date inputs' committed values). */
  fromDay?: string;
  toDay?: string;
}

const MOOD_SET = new Set<string>(moodLevelEnum.options);
const SOURCE_SET = new Set<string>(moodSourceEnum.options);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dayOrUndefined(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && DAY_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Parse the list's URL search params (`?mood&source&from&to`) into the
 * filter object. Unknown moods/sources and malformed days are dropped, so a
 * stale deep link never traps the user on a broken filter.
 */
export function parseMoodListSearchParams(
  params: URLSearchParams,
): MoodListFilters {
  const filters: MoodListFilters = {};

  const mood = params.get("mood")?.trim();
  if (mood && MOOD_SET.has(mood)) filters.mood = mood;

  const source = params.get("source")?.trim();
  if (source && SOURCE_SET.has(source)) filters.source = source;

  const fromDay = dayOrUndefined(params.get("from"));
  if (fromDay) filters.fromDay = fromDay;

  const toDay = dayOrUndefined(params.get("to"));
  if (toDay) filters.toDay = toDay;

  return filters;
}

/**
 * Serialise the filter object back into the page URL's search string (no
 * leading `?`; empty string for the default view). Inverse of
 * `parseMoodListSearchParams`; round-tripping is pinned by test.
 */
export function moodListFiltersToSearch(filters: MoodListFilters): string {
  const sp = new URLSearchParams();
  if (filters.mood) sp.set("mood", filters.mood);
  if (filters.source) sp.set("source", filters.source);
  if (filters.fromDay) sp.set("from", filters.fromDay);
  if (filters.toDay) sp.set("to", filters.toDay);
  return sp.toString();
}
