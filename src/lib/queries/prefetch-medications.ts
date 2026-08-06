import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * v1.16.7 — intent-based data prefetch for the medications page.
 *
 * The nav links already prefetch the route's JS chunk (next/link
 * default in production); what still serialised the first visit was
 * the data hop — the list query only fired once the page chunk had
 * mounted. Wiring this to the nav link's hover / touch / focus intent
 * puts `/api/medications` (the response carries the per-medication
 * `nextDueAt` due times) in flight while the navigation commits.
 *
 * v1.16.8 — the batched card-compliance read
 * (`/api/medications/compliance`) prefetches alongside the list, so the
 * compliance bars + the status line resolve in the same paint as the
 * cards instead of swapping in late. Two independent requests on
 * purpose: the list response must stay fast (the due line never waits
 * on a compliance ledger build), and the compliance prefetch rides the
 * same server-side cache cells the page query would warm anyway.
 *
 * The 15 s prefetch window only bounds how old a cache entry may be
 * before an intent re-fires the request — the mounted page query rides
 * the provider-default `staleTime` (5 min) and consumes whatever this
 * prefetch parked. The server caches both reads per user (60 s list /
 * 15 min compliance, each with an SWR window), so even a missed window
 * stays cheap.
 */
export const MEDICATIONS_LIST_STALE_TIME_MS = 15_000;

export function prefetchMedicationsList(
  queryClient: QueryClient,
  signal?: AbortSignal,
): void {
  void queryClient.prefetchQuery({
    queryKey: queryKeys.medications(),
    queryFn: () => apiGet("/api/medications", { signal }),
    staleTime: MEDICATIONS_LIST_STALE_TIME_MS,
  });
  void queryClient.prefetchQuery({
    queryKey: queryKeys.medicationComplianceSummary(),
    queryFn: () => apiGet("/api/medications/compliance", { signal }),
    staleTime: MEDICATIONS_LIST_STALE_TIME_MS,
  });
}

/**
 * Intent props for a nav link pointing at `/medications` — fires the
 * list prefetch on hover / touch / keyboard focus, i.e. before the
 * router even commits. `prefetchQuery` dedupes internally (in-flight
 * promise reuse + the stale window above), so the three handlers and a
 * subsequent route-commit prefetch collapse into at most one request.
 */
export function medicationsPrefetchIntentProps(queryClient: QueryClient): {
  onPointerEnter: () => void;
  onTouchStart: () => void;
  onFocus: () => void;
} {
  const fire = () => prefetchMedicationsList(queryClient);
  return { onPointerEnter: fire, onTouchStart: fire, onFocus: fire };
}
