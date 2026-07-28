import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { queryKeys } from "@/lib/query-keys";

import {
  applyPatternDecisionSuccess,
  patternDismissalOverrideReducer,
  resolvePatternDismissed,
  type PatternDismissalOverrideState,
} from "../pattern-dismiss-action";

const PATTERN_ID = "pattern-1";

describe("pattern dismissal override state", () => {
  it("applies dismiss and restore transitions optimistically", () => {
    let state: PatternDismissalOverrideState = {};

    state = patternDismissalOverrideReducer(state, {
      type: "optimistic",
      patternId: PATTERN_ID,
      dismissed: true,
    });
    expect(resolvePatternDismissed(state, PATTERN_ID, false)).toBe(true);

    state = patternDismissalOverrideReducer(
      {},
      {
        type: "optimistic",
        patternId: PATTERN_ID,
        dismissed: false,
      },
    );
    expect(resolvePatternDismissed(state, PATTERN_ID, true)).toBe(false);
  });

  it("keeps local state until every owning query invalidation settles", async () => {
    const queryClient = new QueryClient();
    const applyOptimisticState = vi.fn();
    const clearOptimisticState = vi.fn();
    const settleInvalidation: Array<() => void> = [];
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            settleInvalidation.push(resolve);
          }),
      );

    const success = applyPatternDecisionSuccess(
      queryClient,
      applyOptimisticState,
      clearOptimisticState,
    );

    expect(applyOptimisticState).toHaveBeenCalledOnce();
    expect(clearOptimisticState).not.toHaveBeenCalled();
    expect(applyOptimisticState.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateQueries.mock.invocationCallOrder[0],
    );
    expect(invalidateQueries).toHaveBeenCalledTimes(3);
    expect(invalidateQueries).toHaveBeenNthCalledWith(
      1,
      {
        queryKey: queryKeys.analytics(),
      },
      { throwOnError: true },
    );
    expect(invalidateQueries).toHaveBeenNthCalledWith(
      2,
      {
        queryKey: queryKeys.insightsCorrelations(),
      },
      { throwOnError: true },
    );
    expect(invalidateQueries).toHaveBeenNthCalledWith(
      3,
      {
        queryKey: queryKeys.moodInsights(),
      },
      { throwOnError: true },
    );

    settleInvalidation[0]();
    settleInvalidation[1]();
    await Promise.resolve();
    expect(clearOptimisticState).not.toHaveBeenCalled();

    settleInvalidation[2]();
    await success;
    expect(clearOptimisticState).toHaveBeenCalledOnce();
    expect(invalidateQueries.mock.invocationCallOrder[2]).toBeLessThan(
      clearOptimisticState.mock.invocationCallOrder[0],
    );
  });

  it("retains local state when an active query refetch rejects", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const refetchError = new Error("refetch failed");
    const refetch = vi.fn().mockRejectedValue(refetchError);
    queryClient.setQueryData(queryKeys.analytics(), { version: "cached" });
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.analytics(),
      queryFn: refetch,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    let state: PatternDismissalOverrideState = {};
    const applyOptimisticState = vi.fn(() => {
      state = patternDismissalOverrideReducer(state, {
        type: "optimistic",
        patternId: PATTERN_ID,
        dismissed: true,
      });
    });
    const clearOptimisticState = vi.fn(() => {
      state = patternDismissalOverrideReducer(state, {
        type: "settled",
        patternId: PATTERN_ID,
        dismissed: true,
      });
    });

    try {
      await applyPatternDecisionSuccess(
        queryClient,
        applyOptimisticState,
        clearOptimisticState,
      );

      expect(applyOptimisticState).toHaveBeenCalledOnce();
      expect(refetch).toHaveBeenCalledOnce();
      expect(clearOptimisticState).not.toHaveBeenCalled();
      expect(state[PATTERN_ID]).toBe(true);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it("reveals mismatching authoritative state after invalidation settles", () => {
    let state = patternDismissalOverrideReducer(
      {},
      {
        type: "optimistic",
        patternId: PATTERN_ID,
        dismissed: true,
      },
    );

    expect(resolvePatternDismissed(state, PATTERN_ID, false)).toBe(true);

    state = patternDismissalOverrideReducer(state, {
      type: "settled",
      patternId: PATTERN_ID,
      dismissed: true,
    });

    expect(resolvePatternDismissed(state, PATTERN_ID, false)).toBe(false);
    expect(state[PATTERN_ID]).toBeUndefined();
  });

  it("does not let an older lifecycle clear a newer opposite override", () => {
    let state = patternDismissalOverrideReducer(
      {},
      {
        type: "optimistic",
        patternId: PATTERN_ID,
        dismissed: true,
      },
    );
    state = patternDismissalOverrideReducer(state, {
      type: "optimistic",
      patternId: PATTERN_ID,
      dismissed: false,
    });

    state = patternDismissalOverrideReducer(state, {
      type: "settled",
      patternId: PATTERN_ID,
      dismissed: true,
    });

    expect(state[PATTERN_ID]).toBe(false);
    expect(resolvePatternDismissed(state, PATTERN_ID, true)).toBe(false);
  });
});
