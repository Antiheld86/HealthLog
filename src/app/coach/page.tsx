import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { getUnswitchedSession } from "@/lib/auth/acting-carrier";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { readCoachNudgeStatus } from "@/lib/ai/coach/nudge-status";
import { queryKeys } from "@/lib/query-keys";

import CoachPageClient from "./page-client";

/**
 * Thin RSC wrapper around the (client) full-page Coach.
 *
 * The default new-chat hero path carries the one genuine sequential waterfall
 * on this route: the client `coachNudgeStatus` cell fetches
 * `/api/insights/coach/nudge-status` after hydrate, and the conversation's
 * `autoOpenMostRecent` decision is gated on that result — so the hero "pops in
 * after a beat" while the nudge round-trip resolves. This wrapper runs the SAME
 * read the API route uses (`readCoachNudgeStatus`) during SSR and hands it to
 * TanStack via `HydrationBoundary`, so the auto-open decision is available at
 * hydrate and the waterfall step collapses.
 *
 * Contract notes (the v1.30.9 dashboard template):
 *  - The query key comes ONLY from the central factory —
 *    `queryKeys.coachNudgeStatus()` is a deterministic zero-arg tuple, so the
 *    server-seeded key equals the client's `useQuery` key by construction.
 *  - The dehydrated VALUE is JSON-round-tripped; the read already returns ISO
 *    strings, so the shape is byte-identical to the client's
 *    ((await res.json()).data) wire.
 *  - The client cell carries `staleTime: 5min` with the default
 *    `refetchOnMount`, so the seeded fresh value is used at hydrate without an
 *    immediate refetch. When the client query is disabled (a `?c=`/`?doc=`/
 *    `?scope=` deep-link makes it `enabled: false`) the seeded value simply
 *    sits unused — harmless.
 *  - Availability parity: prefetch only when the Coach surface is actually
 *    reachable — the operator `coach` assistant flag is ON
 *    (`requireAssistantSurface` throws otherwise) AND the user has not opted
 *    out (`disableCoach`). Mirrors the client's `!flags.coach || disableCoach`
 *    redirect gate, so a disabled account does no wasted work.
 *  - Left CLIENT-LAZY on purpose: the streaming conversation itself (the SSE
 *    thread, snapshot, any provider-touching path) is NOT prefetched or warmed
 *    — it depends on URL params + the nudge outcome and must never be triggered
 *    server-side.
 *  - Record identity: the session comes from `getUnswitchedSession()`, which
 *    answers null while the browser is acting on somebody else's record. Every
 *    read below scopes to the CALLER, so under a switch the prefetch would
 *    serialise the delegate's own rows into a page opened on the owner's
 *    record. The accessor's docblock carries the argument.
 *  - Fail-soft: no session, the Coach being off, or a DB blip renders the page
 *    exactly as before this wrapper existed — the client cell owns the fetch.
 */
export default async function CoachPage() {
  // Global SSR-prefetch kill-switch shared with the dashboard wrapper. The e2e
  // server sets `DASHBOARD_SSR_PREFETCH=false` so Playwright route mocks — which
  // only see CLIENT fetches — keep governing what every prefetched page paints.
  if (process.env.DASHBOARD_SSR_PREFETCH === "false") {
    return <CoachPageClient />;
  }

  let dehydratedState = null;
  try {
    const session = await getUnswitchedSession();
    if (session && !session.user.disableCoach) {
      // Throws `AssistantDisabledError` when the operator flag is off → caught
      // below, prefetch skipped, client path stands (and redirects to /insights).
      await requireAssistantSurface("coach");
      const nudge = await readCoachNudgeStatus(session.user.id);
      const queryClient = new QueryClient();
      queryClient.setQueryData(
        queryKeys.coachNudgeStatus(),
        JSON.parse(JSON.stringify(nudge)),
      );
      dehydratedState = dehydrate(queryClient);
    }
  } catch {
    // Prefetch is an accelerator, never a gate — the client path stands.
  }

  if (dehydratedState === null) {
    return <CoachPageClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <CoachPageClient />
    </HydrationBoundary>
  );
}
