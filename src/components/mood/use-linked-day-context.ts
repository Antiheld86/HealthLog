"use client";

/**
 * Read what the other modules already hold for one local day.
 *
 * A hook rather than a prop drilled from a page, because both mood surfaces
 * need it and both know only the wall-clock value in their timestamp field.
 * The zone comes from the browser, which is the same zone the account's
 * `displayTimezone` follows for anyone who has not deliberately set it
 * otherwise; the server re-resolves the day either way, so a mismatch shows up
 * as a different day's figures rather than as wrong figures for this one.
 *
 * The query key carries both the day and the zone. One key for both would let
 * whichever answer arrived first serve the other — the same-key /
 * different-shape cache poisoning the key factory exists to prevent, in its
 * quieter same-shape / different-window form.
 */
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { LinkedDayContext } from "@/lib/mood/linked-context";

/** The browser's own zone, which is what the capture sheet is showing. */
function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `YYYY-MM-DD` for a `datetime-local` value, or today when it is empty. */
export function dayOfLocalInput(value: string): string {
  if (value.length >= 10) return value.slice(0, 10);
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

export function useLinkedDayContext(day: string, enabled = true) {
  const tz = browserTimezone();
  const query = useQuery({
    queryKey: queryKeys.moodLinkedContext(day, tz),
    queryFn: () =>
      apiGet<LinkedDayContext>(
        `/api/mood/linked-context?date=${encodeURIComponent(day)}&tz=${encodeURIComponent(tz)}`,
      ),
    enabled,
    // The figures come from other modules and change on their own schedule; a
    // minute of staleness is cheaper than refetching four modules every time
    // the sheet re-renders.
    staleTime: 60_000,
  });
  return query.data ?? null;
}
