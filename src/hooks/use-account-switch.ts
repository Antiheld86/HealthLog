"use client";

/**
 * v1.36.0 — entering and leaving somebody else's record, from the browser.
 *
 * The switch is three acts in a fixed order, and the order is the whole
 * safety argument:
 *
 *   1. **Ask the server.** `POST /api/account/switch` validates the grant and
 *      stamps the session. Nothing local changes until it answers, so a switch
 *      the server refuses leaves the browser exactly where it was.
 *   2. **Empty every cache that survives a reload.** The IndexedDB query
 *      snapshot and the service worker's `healthlog-data-*` cache both answer
 *      reads from disk. Left in place, the first paint on the other side can
 *      be the PREVIOUS record's numbers under a banner naming the new one —
 *      and nothing in the page's own code would be wrong, because the answer
 *      would not have come from the page. Awaited, not fired: a wipe racing
 *      the navigation is a wipe that sometimes does not happen.
 *   3. **Reload the document.** Not `router.refresh()`, not a query
 *      invalidation. A hard navigation is what discards the in-memory cache,
 *      every React state tree holding a rendered value, and every in-flight
 *      request that was issued against the old record. The reload IS the cache
 *      flush; the two lines above it are the parts a reload cannot reach.
 *
 * The hook returns from step 1 and never from step 3 — the page is gone.
 * Callers therefore do not need a success state, only a pending one.
 */

import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { ApiError, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { clearOfflineCachesForRecordSwitch } from "@/lib/pwa/query-persister";
import { queryKeys } from "@/lib/query-keys";
import { setRecordScope } from "@/lib/query-keys/record-scope";

/**
 * The two stable sharing error codes, as the envelope publishes them
 * (`meta.errorCode`). Named here rather than typed inline so the reset
 * below and the "not available while sharing" state cannot drift apart from
 * what the server sends.
 */
export const SHARING_ACCESS_DENIED = "sharing.access.denied";
export const SHARING_NOT_PERMITTED = "sharing.not_permitted";

/** The `meta.errorCode` on a failed request, when it carried one. */
export function errorCodeOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = error.meta?.errorCode;
  return typeof code === "string" ? code : null;
}

/**
 * True when a request failed because the caller may no longer act as the
 * account they are inside — the grant was revoked, lapsed, or never applied to
 * this record.
 *
 * The correct response is not a retry and not an error card: it is to leave the
 * record. A browser that stays inside it shows a banner claiming access it does
 * not have, over a page that will 403 every read.
 */
export function isSharingAccessDenied(error: unknown): boolean {
  return errorCodeOf(error) === SHARING_ACCESS_DENIED;
}

/**
 * True when the surface itself is not available while acting on another
 * account — grant management, credentials, integrations, notification
 * channels, anything that would let a delegate extend their own reach.
 *
 * A different fact from the one above and worth a different message: there is
 * nothing wrong with the caller's access, the page simply is not part of what
 * sharing covers.
 */
export function isSharingNotPermitted(error: unknown): boolean {
  return errorCodeOf(error) === SHARING_NOT_PERMITTED;
}

interface SwitchResponse {
  actingAs: {
    accountId: string;
    username: string;
    displayName: string | null;
    access: "READ" | "WRITE";
  } | null;
}

async function postSwitch(accountId: string | null): Promise<SwitchResponse> {
  return apiPost<SwitchResponse>("/api/account/switch", { accountId });
}

/**
 * Complete the switch: stamp the cache scope, empty the disk layers, reload.
 *
 * Extracted from the mutation so the grant-loss reset can reuse the exact same
 * sequence. Two copies of "wipe, then reload" is one copy too many for a step
 * whose order is the safety property.
 */
async function landOnRecord(
  accountId: string | null,
  destination = "/",
): Promise<never> {
  setRecordScope(accountId);
  await clearOfflineCachesForRecordSwitch();
  window.location.assign(destination);
  // The document is being replaced. Nothing after this runs, and the promise
  // deliberately never settles so no caller paints a "done" state over a page
  // that is on its way out.
  return new Promise<never>(() => {});
}

/**
 * Switch into a record, or (with `null`) back into the caller's own.
 *
 * Errors surface as a toast and leave the browser in place — including the
 * `sharing.access.denied` case, which means the grant ended between the
 * switcher being painted and the click. The list the switcher renders comes
 * from `/api/auth/me`, so the next boot will not offer it again.
 */
export function useAccountSwitch() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationKey: queryKeys.accountSwitchMutation(),
    mutationFn: async ({
      accountId,
      destination,
    }: {
      accountId: string | null;
      destination: string;
    }) => {
      await postSwitch(accountId);
      // The in-memory cache holds the record we are leaving. Clearing it here
      // as well as reloading costs nothing and closes the window in which a
      // failed navigation would leave the old entries reachable.
      queryClient.clear();
      return landOnRecord(accountId, destination);
    },
    onError: (error: unknown) => {
      toast.error(
        isSharingAccessDenied(error)
          ? t("recordSharing.switch.noLongerAvailable")
          : t("recordSharing.switch.failed"),
      );
    },
  });

  return {
    ...mutation,
    /** Preserve the established own-record and exit call sites. */
    mutate: (accountId: string | null) =>
      mutation.mutate({ accountId, destination: "/" }),
    /** Enter a scoped record directly at a server-presentable destination. */
    switchTo: (accountId: string, destination: string) =>
      mutation.mutate({ accountId, destination }),
  };
}

/**
 * Leave a record the server has stopped honouring.
 *
 * The switcher-reset the contract asks for: on `sharing.access.denied` the
 * session is still stamped with an account it may no longer act on, and every
 * delegable read from here on is a 403. Clearing the stamp puts the browser
 * back in its own account rather than leaving somebody staring at a wall of
 * refusals under a banner that says they are somewhere they are not.
 *
 * `POST /api/account/switch` with `null` is an actor surface and always
 * succeeds — it is the way out, by design. If even that fails (offline, server
 * down) the reload still happens: the stamp survives, but so does the honest
 * refusal, and the alternative is a page that neither recovers nor says why.
 */
/**
 * Watch the cache for the moment the server stops honouring the switch.
 *
 * A plain function over a QueryClient rather than an effect body, so a test
 * can drive a real cache into the error state and check what happens — which
 * is the only way to tell a subscriber that fires from one that was written
 * and never wired.
 *
 * Fires `onLoss` at most once. The caller reloads the document, and a second
 * trigger would queue a second navigation behind one already in flight.
 */
export function subscribeToGrantLoss(
  queryClient: QueryClient,
  onLoss: () => void,
): () => void {
  let fired = false;
  return queryClient.getQueryCache().subscribe((event) => {
    if (fired) return;
    if (event.type !== "updated") return;
    if (event.query.state.status !== "error") return;
    if (!isSharingAccessDenied(event.query.state.error)) return;
    fired = true;
    onLoss();
  });
}

export function useLeaveSharedRecordOnGrantLoss() {
  return useCallback(async () => {
    try {
      await postSwitch(null);
    } catch {
      /* the reload below is the part that matters */
    }
    await landOnRecord(null);
  }, []);
}
