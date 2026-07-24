"use client";

/**
 * S2 — client cell for the unified daily digest (`GET /api/daily/digest`).
 *
 * The Today hero reads the ALREADY-CACHED `DailyDigest` DTO S1 assembled
 * server-side. This hook is a plain GET of that cached route — it never
 * warms a provider, never triggers a fresh AI call (the whole daily-value
 * system's warm-on-mount ban extends here); the route composes from the
 * nightly-cached briefing + dashboard snapshot ingredients.
 *
 * Gating: `enabled` is caller-supplied so the page can fold in the
 * `insights` module flag (the digest is the AI-narrative daily layer;
 * the route returns 403 `module.disabled` when insights is off) and the
 * auth state. Freshness mirrors the dashboard snapshot cadence — a warm
 * return-to-dashboard within the `staleTime` is a free cache hit, and a
 * background sync surfaces on focus/poll — so the two above-the-fold
 * cells refresh in lockstep without a second request storm.
 *
 * The read unwraps the `{ data, error }` envelope through `apiGet`
 * (`(await res.json()).data`), and the queryKey is the centralised
 * factory entry `queryKeys.dailyDigest()`.
 */
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import { retryOnceOnTransientError } from "@/lib/queries/retry-transient";
import type { DailyDigest } from "@/lib/daily/digest";

export function useDailyDigest(enabled = true) {
  return useQuery({
    queryKey: queryKeys.dailyDigest(),
    queryFn: () => apiGet<DailyDigest>("/api/daily/digest"),
    enabled,
    // Match the dashboard snapshot's freshness so the hero and the tile
    // strip share one refresh cadence. Every real window-focus transition
    // refetches even inside the minute freshness window: arrival markers are
    // written out-of-band by sync workers, so the browser has no mutation it
    // could use to invalidate this cache. The 120 s foreground poll remains the
    // fallback while the tab stays open.
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: "always",
    // B-4 (INTENDED, not a bug): a dose logged on ANOTHER device (iOS, a
    // Telegram intake, a background sync) has no web invalidation channel, so
    // an open web tab converges on it only via this 120 s foreground poll or
    // the window-focus "always" refetch above — a bounded ≤120 s window on an
    // idle tab. This is deliberate and is NOT the v1.32.19 stale-hero class,
    // which was an in-tab write on the SAME device that marked these reads
    // stale without refetching them (fixed via `invalidateMedicationReads` /
    // `refetchInactiveDailyReads`). Do not conflate the two: a same-device
    // action must clear the hero at once; a cross-device one may lag the poll.
    refetchInterval: DASHBOARD_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // One retry on transient network / 5xx (never 401/403) so a single
    // blip doesn't collapse the hero to its empty degrade.
    retry: retryOnceOnTransientError,
  });
}
