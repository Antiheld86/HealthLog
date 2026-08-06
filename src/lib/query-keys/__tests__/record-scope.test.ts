/**
 * The account dimension of the query cache.
 *
 * These run against a REAL `QueryClient` configured with the app's own default
 * options, not against the hash function in isolation. The question worth
 * answering is not "does the string change" — it is "can a value written while
 * reading one record be read back while reading another", and only the cache
 * itself can answer that.
 *
 * Mutation check, verified: delete `queryKeyHashFn` from
 * `QUERY_CLIENT_DEFAULT_OPTIONS` and the two cross-record leaks below go red
 * with the previous record's data returned verbatim.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/pwa/query-client-options";
import { queryKeys } from "@/lib/query-keys";
import {
  __resetRecordScopeForTests,
  getRecordScope,
  isReadingSharedRecord,
  recordScopedQueryKeyHashFn,
  setRefusedRecordScope,
  setRecordScope,
} from "@/lib/query-keys/record-scope";

function appClient(): QueryClient {
  return new QueryClient({ defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS });
}

beforeEach(() => {
  __resetRecordScopeForTests();
});

describe("the record scope", () => {
  it("starts in the caller's own record", () => {
    expect(getRecordScope()).toBeNull();
    expect(isReadingSharedRecord()).toBe(false);
  });

  it("moves, and comes back", () => {
    setRecordScope("acct-owner");
    expect(getRecordScope()).toBe("acct-owner");
    expect(isReadingSharedRecord()).toBe(true);

    setRecordScope(null);
    expect(getRecordScope()).toBeNull();
    expect(isReadingSharedRecord()).toBe(false);
  });
});

describe("the hash function", () => {
  it("is TanStack's own hash while reading the caller's own record", () => {
    // The overwhelming majority of sessions never switch. Nothing about their
    // cache identity may change, or every persisted entry in the field is
    // orphaned by this release.
    expect(recordScopedQueryKeyHashFn(["dashboard", "snapshot"])).toBe(
      JSON.stringify(["dashboard", "snapshot"]),
    );
  });

  it("sorts object keys, like the hash it replaces", () => {
    // TanStack's `hashKey` is stable across key order inside an object so two
    // spellings of one filter share a slot. Losing that would fragment the
    // cache in a way no test of ours would otherwise notice.
    const a = recordScopedQueryKeyHashFn(["k", { b: 2, a: 1 }]);
    const b = recordScopedQueryKeyHashFn(["k", { a: 1, b: 2 }]);
    expect(a).toBe(b);
  });

  it("gives one key two identities in two records", () => {
    const own = recordScopedQueryKeyHashFn(queryKeys.dashboardSnapshot());
    setRecordScope("acct-owner");
    const shared = recordScopedQueryKeyHashFn(queryKeys.dashboardSnapshot());
    expect(shared).not.toBe(own);
  });
});

describe("the cache cannot serve one record's data while reading another", () => {
  it("hides an entry written in the caller's own record", () => {
    const client = appClient();
    client.setQueryData(queryKeys.dashboardSnapshot(), { weightKg: 71 });
    expect(client.getQueryData(queryKeys.dashboardSnapshot())).toEqual({
      weightKg: 71,
    });

    setRecordScope("acct-owner");

    // The delegate's own numbers must be unreachable from inside somebody
    // else's record. This is the assertion the whole hash exists for.
    expect(client.getQueryData(queryKeys.dashboardSnapshot())).toBeUndefined();
  });

  it("hides an entry written in a shared record once the browser leaves", () => {
    const client = appClient();
    setRecordScope("acct-owner");
    client.setQueryData(queryKeys.dashboardSnapshot(), { weightKg: 92 });

    setRecordScope(null);

    expect(client.getQueryData(queryKeys.dashboardSnapshot())).toBeUndefined();
  });

  it("never puts data from a refused record into the caller's own cache slot", () => {
    const client = appClient();
    client.setQueryData(queryKeys.dashboardSnapshot(), { weightKg: 71 });

    setRefusedRecordScope();

    expect(isReadingSharedRecord()).toBe(true);
    expect(client.getQueryData(queryKeys.dashboardSnapshot())).toBeUndefined();
  });

  it("keeps the auth identity reachable when a refused record changes scope", () => {
    const ownAuthHash = recordScopedQueryKeyHashFn(queryKeys.authMe());

    setRefusedRecordScope();

    expect(recordScopedQueryKeyHashFn(queryKeys.authMe())).toBe(ownAuthHash);
  });

  it("keeps two records' entries apart at the same time", () => {
    const client = appClient();
    setRecordScope("acct-a");
    client.setQueryData(queryKeys.dashboardSnapshot(), { record: "a" });
    setRecordScope("acct-b");
    client.setQueryData(queryKeys.dashboardSnapshot(), { record: "b" });

    expect(client.getQueryData(queryKeys.dashboardSnapshot())).toEqual({
      record: "b",
    });
    setRecordScope("acct-a");
    expect(client.getQueryData(queryKeys.dashboardSnapshot())).toEqual({
      record: "a",
    });
  });
});

describe("prefix invalidation still reaches every slot", () => {
  it("invalidates by key ARRAY, which the hash never touched", () => {
    // The reason the dimension lives on the hash and not on the key arrays.
    // `measurementDependentKeys` and every other bundle in the factory were
    // built at import time, before any record was known; had the arrays grown
    // a scope element, none of them would match anything ever again — and
    // nothing would have failed, the caches would simply have stopped
    // refreshing after a write.
    const client = appClient();
    setRecordScope("acct-owner");
    client.setQueryData(queryKeys.measurementsList(LIST_PARAMS), [1, 2, 3]);

    client.invalidateQueries({ queryKey: queryKeys.measurements() });

    const entry = client
      .getQueryCache()
      .find({ queryKey: queryKeys.measurementsList(LIST_PARAMS) });
    expect(entry).toBeDefined();
    expect(entry?.state.isInvalidated).toBe(true);
  });
});

const LIST_PARAMS = {
  type: undefined,
  sourceEq: undefined,
  from: undefined,
  to: undefined,
  valueMin: undefined,
  valueMax: undefined,
  page: 1,
  sortBy: "measuredAt",
  sortDir: "desc",
  mode: "raw",
} as const;
