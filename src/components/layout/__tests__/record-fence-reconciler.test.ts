/**
 * Reconciling a moved record context without firing the reads it is holding.
 *
 * Both defects this pins were found in a real browser rather than reasoned
 * about, and both look harmless in the source:
 *
 *   * `queryClient.clear()` while the shell is still mounted drops every entry,
 *     and a mounted observer whose entry disappears refetches at once. The tab
 *     that had just been told to hold issued `/api/dashboard/snapshot` and
 *     `/api/medications` under the very context it could not prove;
 *   * an unfiltered `cancelQueries()` cancels the `/api/auth/me` a previous
 *     reconcile started. A stale tab produces one 409 per errored query, so
 *     each new trigger killed the request that would have ended the hold and
 *     the tab never recovered.
 *
 * Run against a real `QueryClient`, for the reason `grant-loss.test.ts` gives:
 * "the effect calls subscribe" is a claim about source, and this is a claim
 * about what a cache full of live observers actually does.
 *
 * Mutation checks, run: put the `removeQueries` back before the `/me` await →
 * "does not refetch a record query it is holding" goes red. Drop the in-flight
 * guard → "does not cancel the /me a previous reconcile started" goes red.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { createRecordFenceReconciler } from "@/components/layout/record-session-fence-bridge";
import { queryKeys } from "@/lib/query-keys";
import { __resetRecordSessionTransitionForTests } from "@/lib/query-keys/record-session-transition";

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
    },
  });
}

/** A record cell with a live observer, exactly as a mounted page holds one. */
async function mountedRecordQuery(
  qc: QueryClient,
  fetcher: () => Promise<unknown>,
) {
  const queryKey = ["dashboard", "snapshot"];
  // A real `QueryObserver` with a live subscriber, which is what a mounted page
  // holds. Without the subscription the query is inactive, removal can never
  // trigger a refetch, and this whole file would pass vacuously.
  const observer = new QueryObserver(qc, { queryKey, queryFn: fetcher });
  const unsubscribe = observer.subscribe(() => {});
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().data).toBeDefined(),
  );
  return { queryKey, unsubscribe };
}

beforeEach(() => {
  __resetRecordSessionTransitionForTests();
});

afterEach(() => {
  __resetRecordSessionTransitionForTests();
});

describe("createRecordFenceReconciler", () => {
  it("keeps the record entries alive until the account payload has answered", async () => {
    // The sequencing IS the fix, and it is what this asserts directly.
    //
    // The defect was `queryClient.clear()` before the `/me` await: a mounted
    // observer whose entry disappears refetches, so the tab that had just been
    // told to hold fired its record reads under the context it could not
    // prove. A node test has no React render loop, so it cannot observe that
    // refetch — asserting "the fetcher was not called again" here would be a
    // check that cannot fail. What it CAN observe, deterministically, is the
    // ordering the refetch depends on: the entry must still exist while `/me`
    // is in flight, and be gone once it has answered.
    const qc = client();
    const { queryKey, unsubscribe } = await mountedRecordQuery(
      qc,
      async () => ({
        value: 1,
      }),
    );

    let releaseMe!: () => void;
    const meGate = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    let presentWhileInFlight: boolean | null = null;
    const refetchAccount = vi.fn(async () => {
      // Sampled from INSIDE the request, which is the only moment that matters:
      // this is precisely when a mounted observer would react to a removal.
      presentWhileInFlight =
        qc.getQueryCache().find({ queryKey }) !== undefined;
      await meGate;
      return { id: "u-1" };
    });

    createRecordFenceReconciler(qc, refetchAccount)();
    await vi.waitFor(() => expect(refetchAccount).toHaveBeenCalledTimes(1));

    expect(presentWhileInFlight).toBe(true);

    releaseMe();
    await vi.waitFor(() =>
      expect(qc.getQueryCache().find({ queryKey })).toBeUndefined(),
    );
    unsubscribe();
  });

  it("removes the stale record entries once the account payload lands", async () => {
    // The positive control for the assertion above: a reconciler that simply
    // never removed anything would pass it.
    const qc = client();
    const { queryKey, unsubscribe } = await mountedRecordQuery(
      qc,
      async () => ({
        value: 1,
      }),
    );
    unsubscribe();

    const refetchAccount = vi.fn(async () => ({ id: "u-1" }));
    createRecordFenceReconciler(qc, refetchAccount)();

    await vi.waitFor(() =>
      expect(qc.getQueryCache().find({ queryKey })).toBeUndefined(),
    );
    // The account cell itself survives — it is the one thing that releases the
    // hold, and removing it would be removing the answer.
    expect(
      qc.getQueryCache().find({ queryKey: queryKeys.authMe() }),
    ).toBeDefined();
  });

  it("does not cancel the /me a previous reconcile started", async () => {
    const qc = client();
    let releaseMe!: () => void;
    const meGate = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    const refetchAccount = vi.fn(async () => {
      await meGate;
      return { id: "u-1" };
    });

    const reconcile = createRecordFenceReconciler(qc, refetchAccount);
    // A burst, which is what a stale tab produces: one 409 per errored query.
    reconcile();
    reconcile();
    reconcile();
    reconcile();

    // One request, not four, and not zero — a reconciler that restarted on
    // every trigger would cancel the request that ends the hold.
    expect(refetchAccount).toHaveBeenCalledTimes(1);

    releaseMe();
    await vi.waitFor(() =>
      expect(
        qc.getQueryCache().find({ queryKey: queryKeys.authMe() })?.state.data,
      ).toEqual({ id: "u-1" }),
    );
  });

  it("accepts a fresh trigger once the previous reconcile settled", async () => {
    // The in-flight guard must be a latch, not a one-shot: a later, genuine
    // disagreement has to be reconciled too.
    const qc = client();
    const refetchAccount = vi.fn(async () => ({ id: "u-1" }));
    const reconcile = createRecordFenceReconciler(qc, refetchAccount);

    reconcile();
    await vi.waitFor(() => expect(refetchAccount).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    reconcile();
    await vi.waitFor(() => expect(refetchAccount).toHaveBeenCalledTimes(2));
  });

  it("stays held when the account payload cannot be fetched", async () => {
    const qc = client();
    const refetchAccount = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const reconcile = createRecordFenceReconciler(qc, refetchAccount);

    reconcile();
    await vi.waitFor(() => expect(refetchAccount).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));

    // The latch released, so a retry is possible — being stuck offline must not
    // also mean being stuck unable to try again.
    reconcile();
    await vi.waitFor(() => expect(refetchAccount).toHaveBeenCalledTimes(2));
  });
});
