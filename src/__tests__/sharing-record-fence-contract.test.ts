/**
 * v1.37.0 — the record-session fence is a cookie-transport contract, frozen.
 *
 * The fence refuses a browser request formed under a record context the session
 * has since left. Everything about it — the epoch, the two request headers, the
 * echo, the 409 — belongs to the cookie transport, and the native contract is
 * unchanged in every direction by it. That is the claim this file freezes,
 * because it is the one a client implementer has to be able to rely on without
 * reading the server: a token sends no fence header, receives none back, and is
 * never refused for the absence of one.
 *
 * ## What lives here rather than beside the fence
 *
 * `src/lib/sharing/__tests__/record-session-fence.test.ts` proves the verdict
 * table and the enforcement, including both Bearer arms. This file proves the
 * two things that face a CLIENT and had no test of their own:
 *
 *   1. `GET /api/auth/me` publishes `recordSession` on a cookie session and
 *      `null` on a token — the field is how a Bearer client is told the fence
 *      does not apply to it, rather than being left to infer that from silence;
 *   2. the PUBLISHED contract says so, in the two request-header parameters and
 *      in the schema of the field, under the exact header names the code uses.
 *
 * The second is not a paraphrase check. A spec that named the headers slightly
 * differently from the server would be a contract nobody could implement
 * against, and the names live in a client-safe module precisely so both ends
 * can be held to one spelling.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RECORD_EPOCH_HEADER,
  RECORD_FENCE_ERROR_CODE,
  RECORD_SCOPE_HEADER,
  RECORD_SCOPE_SELF,
} from "@/lib/sharing/record-session-fence-contract";
import { recordSessionForPayload } from "@/lib/sharing/record-session-fence";
import {
  recordEpochParameter,
  recordScopeParameter,
} from "@/lib/openapi/routes/account-sharing";
import type { AuthContext } from "@/lib/api-handler";

const ROOT = process.cwd();

/**
 * The published parameter, narrowed. `ZodOpenApiObject["components"].parameters`
 * admits a `$ref` as well as an object, so the union has no `name` — these two
 * are literal objects and the cast says which arm they are.
 */
function headerParameter(parameter: unknown): {
  name: string;
  in: string;
  required: boolean;
  description: string;
} {
  return parameter as {
    name: string;
    in: string;
    required: boolean;
    description: string;
  };
}

/** The shape `recordSessionForPayload` reads, and nothing else. */
function auth(
  authMethod: "cookie" | "bearer",
  session: { recordEpoch?: number; actingAsUserId?: string | null } = {},
): AuthContext {
  return {
    authMethod,
    user: { id: "caller" },
    session: {
      recordEpoch: session.recordEpoch,
      actingAsUserId: session.actingAsUserId ?? null,
    },
  } as unknown as AuthContext;
}

describe("what the account payload tells each transport about the fence", () => {
  it("publishes the context a browser adopts", () => {
    expect(
      recordSessionForPayload(
        auth("cookie", { recordEpoch: 3, actingAsUserId: "record-owner" }),
      ),
    ).toEqual({ epoch: 3, scope: "record-owner" });

    // Its own record is `scope: null`, not the absence of the field: null is a
    // first-class answer here, and the header spelling for it is `self`.
    expect(recordSessionForPayload(auth("cookie", { recordEpoch: 0 }))).toEqual(
      { epoch: 0, scope: null },
    );
  });

  it("publishes null on the Bearer transport, however switched the row looks", () => {
    // The stamped columns are ignored rather than absent — a token issued to an
    // account whose session row carries a selector still gets null, because the
    // token has no session and nothing to be stale about. Told explicitly, so a
    // native client can assert on the field instead of inferring from omission.
    expect(
      recordSessionForPayload(
        auth("bearer", { recordEpoch: 9, actingAsUserId: "record-owner" }),
      ),
    ).toBeNull();
  });

  it("treats a session row without an epoch as the un-switched start", () => {
    expect(recordSessionForPayload(auth("cookie"))).toEqual({
      epoch: 0,
      scope: null,
    });
  });
});

describe("what the published contract says about the fence's headers", () => {
  const spec = readFileSync(join(ROOT, "docs/api/openapi.yaml"), "utf8");

  it("publishes both request headers under the names the code uses", () => {
    // One header, two spellings, and the difference is deliberate rather than
    // sloppy: the server matches the lower-case form because that is what an
    // HTTP/2 client sends and what `Headers.get` normalises to, while the spec
    // publishes the canonical capitalisation an implementer will type. Held
    // equal ignoring case, so a genuine rename cannot pass as a casing choice.
    expect(headerParameter(recordEpochParameter).name.toLowerCase()).toBe(
      RECORD_EPOCH_HEADER,
    );
    expect(headerParameter(recordScopeParameter).name.toLowerCase()).toBe(
      RECORD_SCOPE_HEADER,
    );
    expect(spec.toLowerCase()).toContain(RECORD_EPOCH_HEADER);
    expect(spec.toLowerCase()).toContain(RECORD_SCOPE_HEADER);
  });

  it("marks both as cookie-transport only, in the description a client reads", () => {
    for (const parameter of [recordEpochParameter, recordScopeParameter]) {
      const { description } = headerParameter(parameter);
      expect(description.length).toBeGreaterThan(100);
      expect(description).toMatch(/[Cc]ookie transport only/);
      expect(parameter).toMatchObject({ in: "header", required: false });
    }

    // The epoch's description additionally carries the two refusals a client
    // has to tell apart, because they mean opposite things: reconcile and
    // retry, versus leave the record and reload.
    const epoch = headerParameter(recordEpochParameter).description;
    expect(epoch).toContain(RECORD_FENCE_ERROR_CODE);
    expect(epoch).toContain("sharing.access.denied");
  });

  it("publishes the field a client adopts, and that it is null on Bearer", () => {
    // Read off the generated document rather than the source object: the spec
    // is what an implementer holds, and a schema that never reached the YAML
    // would still satisfy an assertion made against the registry.
    const state = spec.slice(spec.indexOf("    RecordSessionState:"));
    // Up to the next schema key at the same indent — matched as "four spaces
    // then a non-space", because a plain four-space search would stop at the
    // first nested line instead.
    const next = /\n {4}\S/.exec(state.slice(1));
    const block = state.slice(0, next ? next.index + 1 : state.length);
    expect(block).toContain("epoch");
    expect(block).toContain("scope");
    expect(block).toMatch(/[Nn]ull on Bearer/);
    expect(block).toContain(RECORD_SCOPE_SELF);
  });
});
