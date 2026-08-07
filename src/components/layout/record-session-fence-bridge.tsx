"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { onRecordFenceMismatch } from "@/lib/api/record-fence";
import { fetchMe } from "@/hooks/use-auth";
import { isRecordSessionChanged } from "@/hooks/use-account-switch";
import { queryKeys } from "@/lib/query-keys";
import { holdForRecordSessionReconcile } from "@/lib/query-keys/record-session-transition";

/**
 * v1.37.0 — hold and reconcile when the server says this browser's record
 * context has moved.
 *
 * Two signals mean the same thing and land in the same place:
 *
 *   * a 409 `sharing.session.changed`, which the fence raises when the asserted
 *     context does not match the session row;
 *   * a 2xx whose ECHOED context contradicts the adopted one — a response that
 *     was in flight across a switch, or a service-worker replay of one cached
 *     before it.
 *
 * The response to both is the same and it is NOT the grant-loss response. This
 * browser does not leave the record: it holds every tab, re-reads
 * `/api/auth/me` network-only, adopts whatever context the server actually
 * holds, and releases. `sharing.session.changed` is deliberately absent from
 * the set `subscribeToGrantLoss` fires on — handing a reconcilable
 * disagreement to a bridge that hard-navigates out of the record would turn a
 * one-frame hold into an eviction.
 *
 * A sibling of `SharedRecordGrantLossBridge` rather than a branch inside it,
 * for the reason that file gives for existing at all: the two answer different
 * questions ("you have lost this record" versus "we disagree about which record
 * this is"), and a single subscriber with a mode flag is how they start
 * answering each other's.
 */

/** Is this the account payload's cell? */
function isAccountQuery(queryKey: readonly unknown[]): boolean {
  const authMe = queryKeys.authMe() as readonly unknown[];
  return (
    queryKey.length === authMe.length &&
    queryKey.every((part, i) => part === authMe[i])
  );
}

/**
 * The reconciliation itself, as a plain function over a `QueryClient`.
 *
 * Extracted from the effect body for the reason `subscribeToGrantLoss` is: a
 * test can drive a real cache through it and check what happened, which is the
 * only way to tell a reconciler that holds from one that quietly refetches the
 * record it is supposed to be holding.
 *
 * ## The two things the first version got wrong
 *
 * **It cleared the cache while the shell was still mounted.**
 * `queryClient.clear()` drops every entry, and a mounted observer whose entry
 * disappears refetches immediately — so the tab that had just been told to hold
 * fired `/api/dashboard/snapshot` and `/api/medications` under the very context
 * it could not prove. The removal therefore waits until AFTER `/api/auth/me`
 * has answered: by then the hold has unmounted the protected children, so there
 * is no observer left to trigger anything.
 *
 * **It cancelled every in-flight query, including the `/me` a previous
 * reconcile had started.** Under a burst of 409s — which is exactly what a
 * stale tab produces, one per errored query — each new reconcile cancelled the
 * request that would have ended the hold, and the tab never recovered. Two
 * fixes, both needed: the cancellation excludes the account cell, and a
 * reconcile already in flight swallows a second trigger rather than restarting.
 */
export function createRecordFenceReconciler(
  queryClient: QueryClient,
  refetchAccount: () => Promise<unknown> = fetchMe,
): () => void {
  let inFlight = false;

  return () => {
    // A burst of 409s is one signal, not many. Restarting on each would cancel
    // the request that ends the hold and livelock the tab.
    if (inFlight) return;
    inFlight = true;

    // Hold FIRST. This is what unmounts the protected children, and everything
    // below depends on them being gone.
    holdForRecordSessionReconcile();

    // Cancel record traffic, never the account payload: the `/me` below is the
    // only thing that can release the hold.
    void queryClient.cancelQueries({
      predicate: (query) => !isAccountQuery(query.queryKey),
    });

    void queryClient
      .fetchQuery({
        queryKey: queryKeys.authMe(),
        queryFn: refetchAccount,
        // NETWORK-ONLY, and this is load-bearing rather than a precaution. The
        // app's default `staleTime` is not zero, so a plain `fetchQuery` would
        // hand back the cached account payload — the one carrying the context
        // this browser has just been told is wrong — and release the hold
        // without ever asking the server. The whole reconciliation would then
        // be a no-op that looked like a success.
        staleTime: 0,
      })
      .then(() => {
        // Now, and not before: the children are unmounted, so removing their
        // entries cannot remount an observer that refetches.
        queryClient.removeQueries({
          predicate: (query) => !isAccountQuery(query.queryKey),
        });
      })
      .catch(() => {
        // Offline, or the server is down. The hold stays, which is the correct
        // place to be stuck: nothing renders under a context this browser
        // cannot prove, and the next successful `/me` releases it.
      })
      .finally(() => {
        inFlight = false;
      });
  };
}

export function RecordSessionFenceBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const reconcile = createRecordFenceReconciler(queryClient);

    // The in-flight / cached-response arm, raised by the transport wrapper.
    const disposeMismatch = onRecordFenceMismatch(reconcile);

    // The 409 arm. Watching the query cache rather than asking ~200 call sites
    // to handle a status code, for the reason the grant-loss bridge gives:
    // a per-call-site handler is a rule the next feature forgets.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.query.state.status !== "error") return;
      if (!isRecordSessionChanged(event.query.state.error)) return;
      reconcile();
    });

    return () => {
      disposeMismatch();
      unsubscribe();
    };
  }, [queryClient]);

  return null;
}
