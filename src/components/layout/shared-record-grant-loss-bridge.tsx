"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  isSharingAccessDenied,
  useLeaveSharedRecordOnGrantLoss,
} from "@/hooks/use-account-switch";

/**
 * v1.36.0 — leave a record the server has stopped honouring.
 *
 * The switcher reset the contract asks for. A grant can end at any moment: the
 * owner presses revoke, or an expiry passes. Revocation clears the delegate's
 * acting sessions in the same transaction, so that path lands them back in
 * their own account by itself. **Expiry does not** — nothing sweeps, the grant
 * simply stops being live on the next request, and the session keeps its stamp.
 * A browser in that state gets a 403 on every read while the banner still says
 * it is inside somebody's record. Correct refusals under a screen that lies.
 *
 * So one subscriber watches the query cache for the stable
 * `sharing.access.denied` code and, on the first one, clears the switch and
 * reloads. Watching the cache rather than asking ~200 call sites to handle a
 * code is the point: a per-call-site handler is a rule the next feature
 * forgets, and forgetting it here means somebody is stuck.
 *
 * Fires once. `landOnRecord` never resolves (the document is being replaced),
 * so a second trigger would queue a second reload behind a navigation already
 * in flight; the ref makes the first one the only one.
 */
export function SharedRecordGrantLossBridge() {
  const queryClient = useQueryClient();
  const leave = useLeaveSharedRecordOnGrantLoss();
  const leaving = useRef(false);

  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (leaving.current) return;
      if (event.type !== "updated") return;
      if (event.query.state.status !== "error") return;
      if (!isSharingAccessDenied(event.query.state.error)) return;
      leaving.current = true;
      void leave();
    });
    return unsubscribe;
  }, [queryClient, leave]);

  return null;
}
