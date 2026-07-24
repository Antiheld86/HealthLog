/**
 * v1.32.21 (R5a) — the client-side optimistic-concurrency primitives every
 * guarded writer uses (`readUpdatedAtToken`, `withBaseToken`, `isConflict`),
 * plus the B-3 token-preservation guarantee for the insights-layout read.
 */
import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import {
  readUpdatedAtToken,
  withBaseToken,
  isConflict,
} from "@/lib/api/optimistic-token";
import { ApiError } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import {
  resolveInsightsLayout,
  DEFAULT_INSIGHTS_LAYOUT,
  type InsightsLayoutWithToken,
} from "@/lib/insights-layout";

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

describe("readUpdatedAtToken", () => {
  it("returns the cached updatedAt token at read time", () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.insightsLayout(), {
      version: 2,
      updatedAt: "2026-07-24T10:00:00.000Z",
    });
    expect(readUpdatedAtToken(qc, queryKeys.insightsLayout())).toBe(
      "2026-07-24T10:00:00.000Z",
    );
  });

  it("returns undefined when nothing is cached or the token is absent", () => {
    const qc = makeClient();
    expect(readUpdatedAtToken(qc, queryKeys.insightsLayout())).toBeUndefined();
    qc.setQueryData(queryKeys.insightsLayout(), { version: 2 });
    expect(readUpdatedAtToken(qc, queryKeys.insightsLayout())).toBeUndefined();
  });
});

describe("withBaseToken", () => {
  it("attaches baseUpdatedAt when the token is known", () => {
    expect(withBaseToken({ version: 1 }, "2026-07-24T10:00:00.000Z")).toEqual({
      version: 1,
      baseUpdatedAt: "2026-07-24T10:00:00.000Z",
    });
  });

  it("omits the field entirely for a tokenless client (backward-compat)", () => {
    const out = withBaseToken({ version: 1 }, undefined);
    expect(out).toEqual({ version: 1 });
    expect("baseUpdatedAt" in out).toBe(false);
  });
});

describe("isConflict", () => {
  it("is true only for a 409 ApiError", () => {
    expect(isConflict(new ApiError("conflict", 409))).toBe(true);
    expect(isConflict(new ApiError("bad", 422))).toBe(false);
    expect(isConflict(new Error("boom"))).toBe(false);
    expect(isConflict(undefined)).toBe(false);
  });
});

/**
 * B-3 — the insights-layout GET pipes through `resolveInsightsLayout`, which
 * rebuilds a FIXED shape and DROPS `updatedAt`. If the hook did not re-attach
 * the token, every insights-layout write would silently fall back to the
 * server's compat (unconditional) arm and the guard would be dead on arrival.
 */
describe("B-3 insights-layout token preservation", () => {
  it("resolveInsightsLayout strips the server token (why the hook must re-attach)", () => {
    const withToken = {
      ...DEFAULT_INSIGHTS_LAYOUT,
      updatedAt: "2026-07-24T10:00:00.000Z",
    };
    const resolved = resolveInsightsLayout(withToken) as {
      updatedAt?: string;
    };
    expect(resolved.updatedAt).toBeUndefined();
  });

  it("the hook's re-attach keeps the token, so a later write can echo it", () => {
    const raw: InsightsLayoutWithToken = {
      ...DEFAULT_INSIGHTS_LAYOUT,
      updatedAt: "2026-07-24T10:00:00.000Z",
    };
    // Mirrors the hook's queryFn: resolve, then re-attach the token.
    const cached: InsightsLayoutWithToken = {
      ...resolveInsightsLayout(raw),
      updatedAt: raw.updatedAt,
    };

    const qc = makeClient();
    qc.setQueryData(queryKeys.insightsLayout(), cached);
    // The token survives into the cache the writers read at mutate time.
    expect(readUpdatedAtToken(qc, queryKeys.insightsLayout())).toBe(
      "2026-07-24T10:00:00.000Z",
    );
  });
});
