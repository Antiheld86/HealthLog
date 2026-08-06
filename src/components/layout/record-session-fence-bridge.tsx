"use client";

import { useQueryClient } from "@tanstack/react-query";
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
export function RecordSessionFenceBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    /**
     * Held, then reconciled. `fetchMe` adopts the context and settles the
     * transition itself, so nothing here decides what the browser is allowed
     * to render next — the server's answer does.
     */
    const reconcile = () => {
      holdForRecordSessionReconcile();
      void queryClient.cancelQueries();
      queryClient.clear();
      void queryClient
        .fetchQuery({ queryKey: queryKeys.authMe(), queryFn: fetchMe })
        .catch(() => {
          // Offline, or the server is down. The hold stays, which is the
          // correct place to be stuck: nothing renders under a context this
          // browser cannot prove, and the next successful `/me` releases it.
        });
    };

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
