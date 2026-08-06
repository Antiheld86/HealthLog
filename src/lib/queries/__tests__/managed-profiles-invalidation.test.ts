/**
 * A created managed profile reaches the switcher.
 *
 * ## The claim, and why it is not "the mutation calls invalidate"
 *
 * The list of profiles somebody looks after is not a read of its own. It is
 * `accountAccess.accounts` on `GET /api/auth/me`, filtered to the managed
 * entries — the same block that paints the account switcher and the shared-
 * record banner. So "the new profile appears without a reload" is exactly one
 * property: the account payload comes back invalidated when the creation
 * succeeds. A mutation that refreshed the sharing panel and not the payload
 * would leave the profile invisible in the card, in the switcher and in the
 * banner at once, and nothing on screen would say a read was stale.
 *
 * That claim can only be answered by a real `QueryClient` with the reads in
 * it, so the hook's success handler is driven against one. `@tanstack/react-
 * query` is mocked down to the two functions the hook body calls, which is
 * what lets the body run outside React: the unit environment is `node`, there
 * is no jsdom and no testing-library in this repo.
 *
 * Mutation check, run: point `invalidateManagedProfileReads` at the grant list
 * alone and "refreshes the account payload" goes red while every other leg
 * here stays green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/pwa/query-client-options";
import { queryKeys } from "@/lib/query-keys";
import { __resetRecordScopeForTests } from "@/lib/query-keys/record-scope";

/** The client the mocked `useQueryClient` hands back. Reassigned per case. */
const clientRef: { value: QueryClient } = { value: seeded() };

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    // The hook body is what is under test, so the two hooks it calls are
    // replaced by the smallest things that let it run: one that records the
    // options object, one that hands over a real client.
    useMutation: (options: unknown) => options,
    useQueryClient: () => clientRef.value,
  };
});

import {
  invalidateManagedProfileReads,
  useCreateManagedProfile,
} from "@/lib/queries/use-managed-profiles";

function seeded(): QueryClient {
  const client = new QueryClient({
    defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS,
  });
  client.setQueryData(queryKeys.accountGrants(), {
    given: [],
    received: [],
    retentionDays: 365,
  });
  client.setQueryData(queryKeys.accountActivity(), {
    entries: [],
    retentionDays: 365,
    truncated: false,
  });
  client.setQueryData(queryKeys.authMe(), { id: "guardian" });
  client.setQueryData(queryKeys.managedProfileGuardians("p1"), []);
  return client;
}

function invalidated(client: QueryClient, key: readonly unknown[]): boolean {
  return (
    client.getQueryCache().find({ queryKey: key })?.state.isInvalidated === true
  );
}

beforeEach(() => {
  __resetRecordScopeForTests();
  clientRef.value = seeded();
});

describe("what a managed-profile change refreshes", () => {
  it("starts from four live, valid entries", () => {
    // Non-zero proof. Without it a client that failed to seed and a client
    // whose entries were all invalidated read identically below: every
    // `find()` returns undefined and each assertion becomes a quiet
    // `undefined !== true`.
    const all = clientRef.value.getQueryCache().getAll();
    expect(all).toHaveLength(4);
    expect(all.every((q) => q.state.isInvalidated)).toBe(false);
  });

  it("refreshes the account payload, which carries the switcher", () => {
    invalidateManagedProfileReads(clientRef.value);
    expect(invalidated(clientRef.value, queryKeys.authMe())).toBe(true);
  });

  it("refreshes the grant list and the record-activity feed", () => {
    invalidateManagedProfileReads(clientRef.value);
    expect(invalidated(clientRef.value, queryKeys.accountGrants())).toBe(true);
    expect(invalidated(clientRef.value, queryKeys.accountActivity())).toBe(
      true,
    );
  });

  it("refreshes a profile's guardian roster through the family prefix", () => {
    // Accepting a Guardian invitation is an ordinary grant accept, and it
    // moves a row on a roster that endpoint knows nothing about. The prefix is
    // what keeps the two in step.
    invalidateManagedProfileReads(clientRef.value);
    expect(
      invalidated(clientRef.value, queryKeys.managedProfileGuardians("p1")),
    ).toBe(true);
  });
});

describe("the creation hook, driven for real", () => {
  it("posts the four fields the strict schema accepts, and no others", async () => {
    const options = useCreateManagedProfile() as unknown as {
      mutationFn: (input: unknown) => Promise<unknown>;
      onSuccess: () => void;
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "p9" }, error: null }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    await options.mutationFn({
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "Europe/Berlin",
    });

    const [path, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/managed-profiles");
    expect(init.method).toBe("POST");
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual([
      "dateOfBirth",
      "displayName",
      "locale",
      "timezone",
    ]);
    fetchSpy.mockRestore();
  });

  it("puts the new profile in the switcher by refreshing the payload", () => {
    const options = useCreateManagedProfile() as unknown as {
      onSuccess: () => void;
    };
    options.onSuccess();
    expect(invalidated(clientRef.value, queryKeys.authMe())).toBe(true);
  });
});
