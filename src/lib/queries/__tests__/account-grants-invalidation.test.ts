/**
 * A grant transition refreshes everything it can have changed.
 *
 * The standing rule this checks is not "the mutation calls invalidate" — that
 * is a claim about the source. It is "the three reads a grant transition makes
 * stale come back invalidated", and the only thing that can answer it is a
 * real `QueryClient` with those three reads in it.
 *
 * The third one is the interesting one. The grant list and the activity feed
 * are the surface a person is looking at; `["auth","me"]` is the account
 * payload, which carries `accountAccess` — the switcher's menu and the banner.
 * Forget it and a revoked record keeps its entry in the menu: the affordance
 * still on screen, the click already refused by the server.
 *
 * Mutation check, run: drop `queryKeys.authMe()` from `grantDependentKeys`
 * and "refreshes the account payload" goes red.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/pwa/query-client-options";
import { invalidateGrantReads } from "@/lib/queries/use-account-grants";
import { queryKeys } from "@/lib/query-keys";
import { __resetRecordScopeForTests } from "@/lib/query-keys/record-scope";

beforeEach(() => {
  __resetRecordScopeForTests();
});

function seeded(): QueryClient {
  const client = new QueryClient({
    defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS,
  });
  client.setQueryData(queryKeys.accountGrants(), { given: [], received: [] });
  client.setQueryData(queryKeys.accountActivity(), {
    entries: [],
    retentionDays: 365,
  });
  client.setQueryData(queryKeys.authMe(), { id: "u1" });
  return client;
}

describe("invalidateGrantReads", () => {
  it("refreshes the grant list", () => {
    const client = seeded();
    invalidateGrantReads(client);
    expect(
      client.getQueryCache().find({ queryKey: queryKeys.accountGrants() })
        ?.state.isInvalidated,
    ).toBe(true);
  });

  it("refreshes the owner's record-activity feed", () => {
    const client = seeded();
    invalidateGrantReads(client);
    expect(
      client.getQueryCache().find({ queryKey: queryKeys.accountActivity() })
        ?.state.isInvalidated,
    ).toBe(true);
  });

  it("refreshes the account payload, which carries the switcher", () => {
    const client = seeded();
    invalidateGrantReads(client);
    expect(
      client.getQueryCache().find({ queryKey: queryKeys.authMe() })?.state
        .isInvalidated,
    ).toBe(true);
  });

  it("starts from three live, valid entries", () => {
    // Non-zero proof. Without this, a client that failed to seed and a client
    // whose entries were all invalidated look identical from the assertions
    // above — every `find()` would return undefined and `?.state` would make
    // each one a quiet `undefined !== true`.
    const client = seeded();
    const all = client.getQueryCache().getAll();
    expect(all).toHaveLength(3);
    expect(all.every((q) => q.state.isInvalidated)).toBe(false);
  });
});
