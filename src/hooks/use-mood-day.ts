"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

/**
 * Every mood entry a person logged on ONE local day, from
 * `GET /api/mood-entries?from=<day>&to=<day>`.
 *
 * The route filters on the mood `date` column, which already IS the local
 * day key, so no timezone maths happens here. Entries come back newest
 * first (`sortBy=moodLoggedAt`, `sortDir=desc`, the route's defaults).
 */
export interface MoodDayEntry {
  id: string;
  date: string;
  /** The mood enum, e.g. `GUT`. Rendered through `MOOD_LABEL_KEYS`. */
  mood: string;
  score: number;
  note: string | null;
  source: string;
  moodLoggedAt: string;
}

interface MoodDayResponse {
  entries: MoodDayEntry[];
  meta: { total: number };
}

export interface UseMoodDayResult {
  /** `undefined` until the route has answered; `[]` means the day really
   *  carried no entry. */
  entries: MoodDayEntry[] | undefined;
  isError: boolean;
  refetch: () => void;
}

/**
 * Reads one day's mood entries.
 *
 * `enabled` is the caller's gate — pass `false` when the user is signed
 * out, and nothing is fetched. Mood has no module gate, so there is
 * nothing else to check.
 */
export function useMoodDay(
  date: string | undefined,
  enabled: boolean,
): UseMoodDayResult {
  const { data, isError, refetch } = useQuery({
    queryKey: queryKeys.moodEntriesDay(date ?? ""),
    queryFn: () => {
      const params = new URLSearchParams({
        from: date as string,
        to: date as string,
        limit: "50",
      });
      return apiGet<MoodDayResponse>(`/api/mood-entries?${params}`);
    },
    enabled: enabled && Boolean(date),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  return {
    entries: data?.entries,
    isError,
    refetch: () => void refetch(),
  };
}
