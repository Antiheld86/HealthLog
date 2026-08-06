/**
 * The record-session fence: every arm of the verdict, and the refusals it
 * raises.
 *
 * The verdict is a pure function, so this file can be exhaustive about it in a
 * way the integration proofs cannot. It also holds two structural assertions
 * that belong nowhere else:
 *
 *   * the contract module has no `import` statement at all — the property that
 *     lets the browser bundle name the same header constants without dragging
 *     `next/headers` or Prisma in behind them. It typechecks either way, so
 *     only a check like this one or a full `pnpm build` catches a regression;
 *   * the asserted-scope length bound equals `MAX_SELECTOR_LENGTH`. The
 *     contract module deliberately does not import that constant (importing
 *     `acting-carrier.ts` is the exact poisoning above), so nothing but an
 *     assertion keeps the two numbers together.
 *
 * Break this file by changing the `unfenced-client` arm of
 * `recordSessionFenceVerdict` to return `"pass"`: every absent-header case on a
 * fenced session fails.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_SELECTOR_LENGTH } from "@/lib/auth/acting-carrier";
import {
  MAX_ASSERTED_SCOPE_LENGTH,
  RECORD_EPOCH_HEADER,
  RECORD_FENCE_BOOTSTRAP,
  RECORD_FENCE_ERROR_CODE,
  RECORD_SCOPE_HEADER,
  RECORD_SCOPE_SELF,
  parseAssertedContext,
  recordScopeHeaderValue,
  recordSessionFenceVerdict,
  type AssertedRecordContext,
  type RecordFenceVerdict,
} from "@/lib/sharing/record-session-fence-contract";

const headerJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
  })),
}));

const OWNER = "owner-account-id";
const OTHER = "other-account-id";

function asserted(epoch: number, scope: string | null): AssertedRecordContext {
  return { kind: "asserted", epoch, scope };
}

describe("recordSessionFenceVerdict", () => {
  type Case = {
    name: string;
    input: Parameters<typeof recordSessionFenceVerdict>[0];
    want: RecordFenceVerdict;
  };

  const CASES: Case[] = [
    {
      name: "bearer passes with no assertion at all",
      input: {
        transport: "bearer",
        sessionEpoch: 0,
        sessionScope: null,
        asserted: { kind: "absent" },
      },
      want: "pass",
    },
    {
      name: "bearer passes even against a nonsense assertion",
      input: {
        transport: "bearer",
        sessionEpoch: 7,
        sessionScope: OWNER,
        asserted: asserted(1, OTHER),
      },
      want: "pass",
    },
    {
      name: "a session that never switched passes with no header",
      input: {
        transport: "cookie",
        sessionEpoch: 0,
        sessionScope: null,
        asserted: { kind: "absent" },
      },
      want: "pass",
    },
    {
      name: "a session that never switched passes on the bootstrap sentinel",
      input: {
        transport: "cookie",
        sessionEpoch: 0,
        sessionScope: null,
        asserted: { kind: "unparseable" },
      },
      want: "pass",
    },
    {
      name: "a fenced session with a matching epoch and scope passes",
      input: {
        transport: "cookie",
        sessionEpoch: 3,
        sessionScope: OWNER,
        asserted: asserted(3, OWNER),
      },
      want: "pass",
    },
    {
      name: "a fenced session back on its own record passes on a matching self assertion",
      input: {
        transport: "cookie",
        sessionEpoch: 4,
        sessionScope: null,
        asserted: asserted(4, null),
      },
      want: "pass",
    },
    {
      name: "a stale epoch is stale",
      input: {
        transport: "cookie",
        sessionEpoch: 3,
        sessionScope: OWNER,
        asserted: asserted(2, OWNER),
      },
      want: "stale",
    },
    {
      name: "an epoch from the future is stale",
      input: {
        transport: "cookie",
        sessionEpoch: 3,
        sessionScope: OWNER,
        asserted: asserted(4, OWNER),
      },
      want: "stale",
    },
    {
      name: "a matching epoch with a mismatched scope is stale",
      input: {
        transport: "cookie",
        sessionEpoch: 3,
        sessionScope: OWNER,
        asserted: asserted(3, OTHER),
      },
      want: "stale",
    },
    {
      name: "asserting a record while the session is on its own is stale",
      input: {
        transport: "cookie",
        sessionEpoch: 5,
        sessionScope: null,
        asserted: asserted(5, OWNER),
      },
      want: "stale",
    },
    {
      name: "asserting self while the session is inside a record is stale",
      input: {
        transport: "cookie",
        sessionEpoch: 5,
        sessionScope: OWNER,
        asserted: asserted(5, null),
      },
      want: "stale",
    },
    {
      name: "an unparseable assertion on a fenced session is stale, not unfenced",
      input: {
        transport: "cookie",
        sessionEpoch: 1,
        sessionScope: OWNER,
        asserted: { kind: "unparseable" },
      },
      want: "stale",
    },
    {
      name: "an absent assertion on a fenced session is an unfenced client",
      input: {
        transport: "cookie",
        sessionEpoch: 1,
        sessionScope: OWNER,
        asserted: { kind: "absent" },
      },
      want: "unfenced-client",
    },
    {
      name: "a session that has LEFT a record stays fenced",
      input: {
        transport: "cookie",
        sessionEpoch: 2,
        sessionScope: null,
        asserted: { kind: "absent" },
      },
      want: "unfenced-client",
    },
  ];

  it("covers a non-zero number of cases", () => {
    // A table-driven test whose table emptied would report success.
    expect(CASES.length).toBeGreaterThan(10);
  });

  for (const c of CASES) {
    it(c.name, () => {
      expect(recordSessionFenceVerdict(c.input)).toBe(c.want);
    });
  }

  it("keeps the exemption's second clause honest", () => {
    // Migration 0302 makes `scope !== null` imply `epoch >= 1`, so the second
    // conjunct of the exemption is redundant against real data. It is kept
    // because a redundant clause over an authorization boundary is the right
    // direction to be wrong in — and this asserts it actually does something
    // if the data ever disagrees with the migration.
    expect(
      recordSessionFenceVerdict({
        transport: "cookie",
        sessionEpoch: 0,
        sessionScope: OWNER,
        asserted: { kind: "absent" },
      }),
    ).toBe("unfenced-client");
  });
});

describe("parseAssertedContext", () => {
  it("reads no headers as absent", () => {
    expect(parseAssertedContext(null, null)).toEqual({ kind: "absent" });
  });

  it("reads half an assertion as unparseable, never as absent", () => {
    // Half an assertion comes from a client that knows about the fence, so it
    // must take the reconcile arm and not the leave-the-record arm.
    expect(parseAssertedContext("3", null)).toEqual({ kind: "unparseable" });
    expect(parseAssertedContext(null, RECORD_SCOPE_SELF)).toEqual({
      kind: "unparseable",
    });
  });

  it("reads the bootstrap sentinel as unparseable", () => {
    expect(
      parseAssertedContext(RECORD_FENCE_BOOTSTRAP, RECORD_FENCE_BOOTSTRAP),
    ).toEqual({ kind: "unparseable" });
  });

  it.each([
    ["not-a-number", "nonsense"],
    ["-1", "negative"],
    ["3.5", "fractional"],
    ["1e3", "exponential"],
    [" 3", "padded"],
    ["", "empty"],
    ["9".repeat(40), "over-long"],
  ])("reads %s as unparseable (%s)", (value) => {
    expect(parseAssertedContext(value, RECORD_SCOPE_SELF)).toEqual({
      kind: "unparseable",
    });
  });

  it("reads an over-long scope as unparseable before comparing it", () => {
    expect(
      parseAssertedContext("3", "x".repeat(MAX_ASSERTED_SCOPE_LENGTH + 1)),
    ).toEqual({ kind: "unparseable" });
  });

  it("reads an empty scope as unparseable", () => {
    expect(parseAssertedContext("3", "")).toEqual({ kind: "unparseable" });
  });

  it("reads the self sentinel as the null scope", () => {
    expect(parseAssertedContext("0", RECORD_SCOPE_SELF)).toEqual({
      kind: "asserted",
      epoch: 0,
      scope: null,
    });
  });

  it("reads an account id as itself", () => {
    expect(parseAssertedContext("12", OWNER)).toEqual({
      kind: "asserted",
      epoch: 12,
      scope: OWNER,
    });
  });

  it("round-trips a scope through the header value helper", () => {
    for (const scope of [null, OWNER]) {
      expect(parseAssertedContext("1", recordScopeHeaderValue(scope))).toEqual({
        kind: "asserted",
        epoch: 1,
        scope,
      });
    }
  });
});

describe("the contract module is safe in the browser bundle", () => {
  const CONTRACT = join(
    process.cwd(),
    "src/lib/sharing/record-session-fence-contract.ts",
  );

  it("has no import statement at all", () => {
    const src = readFileSync(CONTRACT, "utf8");
    // Non-zero proof first: if the file were empty or misspelled, an
    // "it contains no imports" assertion would pass for the wrong reason.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("RECORD_EPOCH_HEADER");
    expect(src).not.toMatch(/^\s*import[\s{*]/m);
    expect(src).not.toMatch(/\bfrom\s+["']/);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  it("bounds an asserted scope at the same length as an account selector", () => {
    expect(MAX_ASSERTED_SCOPE_LENGTH).toBe(MAX_SELECTOR_LENGTH);
  });

  it("names the two headers on the cookie transport's own namespace", () => {
    expect(RECORD_EPOCH_HEADER).toBe("x-healthlog-record-epoch");
    expect(RECORD_SCOPE_HEADER).toBe("x-healthlog-record-scope");
    expect(RECORD_FENCE_ERROR_CODE).toBe("sharing.session.changed");
  });
});

describe("attachRecordContextEcho", () => {
  async function attach(
    context: { epoch: number; scope: string | null } | undefined,
    initial?: Record<string, string>,
  ): Promise<Headers> {
    const { attachRecordContextEcho } =
      await import("@/lib/sharing/record-session-fence");
    const headers = new Headers(initial);
    attachRecordContextEcho(headers, context);
    return headers;
  }

  it("declares that the answer varies on the two fence headers", async () => {
    // Without this a shared cache — one reverse proxy away — would key a
    // delegated record response on URL alone and serve it to the next request
    // for the same URL under a different context. One person's record handed
    // to another by an infrastructure change nobody thought was a code change.
    const headers = await attach({ epoch: 4, scope: "owner-1" });
    const vary = (headers.get("Vary") ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase());
    expect(vary).toContain(RECORD_EPOCH_HEADER);
    expect(vary).toContain(RECORD_SCOPE_HEADER);
  });

  it("keeps a Vary the route had already set", async () => {
    const headers = await attach(
      { epoch: 1, scope: null },
      { Vary: "Accept-Encoding" },
    );
    const vary = (headers.get("Vary") ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase());
    expect(vary).toContain("accept-encoding");
    expect(vary).toContain(RECORD_EPOCH_HEADER);
  });

  it("does not repeat a header the route already varied on", async () => {
    const headers = await attach(
      { epoch: 1, scope: null },
      { Vary: `Accept-Encoding, ${RECORD_EPOCH_HEADER.toUpperCase()}` },
    );
    const vary = (headers.get("Vary") ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase());
    expect(vary.filter((v) => v === RECORD_EPOCH_HEADER)).toHaveLength(1);
  });

  it("adds nothing at all when no record scope was resolved", async () => {
    // The response carries no echo, so there is nothing for a cache to vary
    // on — and claiming otherwise would fragment the cache key of every public
    // route for no reason.
    const headers = await attach(undefined);
    expect(headers.get("Vary")).toBeNull();
    expect(headers.get(RECORD_EPOCH_HEADER)).toBeNull();
  });
});

describe("assertRecordSessionFence", () => {
  beforeEach(() => {
    headerJar.clear();
    vi.resetModules();
  });

  async function run(input: {
    authMethod: "cookie" | "bearer";
    recordEpoch?: number;
    actingAsUserId?: string | null;
  }): Promise<{ error: unknown; stamped: unknown }> {
    const { assertRecordSessionFence } =
      await import("@/lib/sharing/record-session-fence");
    let stamped: unknown;
    const { eventStorage } = await import("@/lib/logging/context");
    const { WideEventBuilder } = await import("@/lib/logging/event-builder");
    const evt = new WideEventBuilder();
    let error: unknown = null;
    await eventStorage.run(evt, async () => {
      try {
        await assertRecordSessionFence({
          session: {
            id: "session-1",
            expiresAt: new Date(Date.now() + 60_000),
            actingAsUserId: input.actingAsUserId ?? null,
            recordEpoch: input.recordEpoch,
          },
          user: { id: "delegate" } as never,
          authMethod: input.authMethod,
        });
      } catch (err) {
        error = err;
      }
      stamped = evt.getRecordContext();
    });
    return { error, stamped };
  }

  it("serves a never-switched cookie session and stamps its context", async () => {
    const { error, stamped } = await run({ authMethod: "cookie" });
    expect(error).toBeNull();
    expect(stamped).toEqual({ epoch: 0, scope: null });
  });

  it("serves a matching assertion and stamps the context it served under", async () => {
    headerJar.set(RECORD_EPOCH_HEADER, "4");
    headerJar.set(RECORD_SCOPE_HEADER, OWNER);
    const { error, stamped } = await run({
      authMethod: "cookie",
      recordEpoch: 4,
      actingAsUserId: OWNER,
    });
    expect(error).toBeNull();
    expect(stamped).toEqual({ epoch: 4, scope: OWNER });
  });

  it("throws the 409 on a stale assertion, and still stamps the truth", async () => {
    headerJar.set(RECORD_EPOCH_HEADER, "3");
    headerJar.set(RECORD_SCOPE_HEADER, OWNER);
    const { error, stamped } = await run({
      authMethod: "cookie",
      recordEpoch: 4,
      actingAsUserId: OWNER,
    });
    expect((error as { statusCode?: number }).statusCode).toBe(409);
    expect((error as { errorCode?: string }).errorCode).toBe(
      RECORD_FENCE_ERROR_CODE,
    );
    // The refusal echoes the real context too, so a client that reconciles on
    // the discard path and one that reconciles on the 409 path see the same
    // thing on the wire.
    expect(stamped).toEqual({ epoch: 4, scope: OWNER });
  });

  it("throws the 403 a pre-fence bundle recovers from when no header arrives", async () => {
    const { error } = await run({
      authMethod: "cookie",
      recordEpoch: 1,
      actingAsUserId: OWNER,
    });
    expect((error as { statusCode?: number }).statusCode).toBe(403);
    expect((error as { errorCode?: string }).errorCode).toBe(
      "sharing.access.denied",
    );
  });

  it("leaves the Bearer transport alone and echoes nothing on it", async () => {
    headerJar.set(RECORD_EPOCH_HEADER, "1");
    headerJar.set(RECORD_SCOPE_HEADER, OTHER);
    const { error, stamped } = await run({
      authMethod: "bearer",
      recordEpoch: 9,
      actingAsUserId: OWNER,
    });
    expect(error).toBeNull();
    expect(stamped).toBeUndefined();
  });

  it("treats an absent recordEpoch as zero, so a hand-built context is unfenced", async () => {
    const { error } = await run({
      authMethod: "cookie",
      recordEpoch: undefined,
      actingAsUserId: null,
    });
    expect(error).toBeNull();
  });
});
