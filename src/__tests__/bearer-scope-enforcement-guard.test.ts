/**
 * Structural guards on the Bearer-scope enforcement boundary.
 *
 * The correctness argument for the fail-closed default is structural, not
 * empirical: there is exactly ONE place a raw Bearer token becomes a user, and
 * exactly ONE authorisation arm inside it. Seven behavioural tests cannot cover
 * 300-odd routes; what they can do is rest on that invariant. These guards are
 * what keep the invariant true.
 *
 * They are tripwires, not proofs. They cannot show an allowlist is correct —
 * only that it has not changed without someone editing this file. A reviewer
 * who waves through a bad addition defeats all four, and no test substitutes
 * for that review.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * Every non-test `.ts` / `.tsx` under `src/`, excluding the generated Prisma
 * client (9 MB; never read it) and test files themselves.
 */
function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

function filesMatching(re: RegExp): string[] {
  return sourceFiles().filter((rel) => re.test(read(rel)));
}

describe("T1 — the Bearer resolution set is frozen", () => {
  /**
   * Files allowed to turn a raw `Authorization: Bearer` value into a user.
   * This is the set that can circumvent the enforcement point, so it is the
   * only set that matters for the fail-closed guarantee.
   *
   * Two of these authenticate a request; the rest are the resolver itself and
   * the two edges that wrap it.
   */
  const RESOLUTION_ALLOWLIST = [
    // The resolver. Owns the one authorisation arm.
    "lib/auth/bearer.ts",
    // The REST edge — maps `requireAuth`'s optional scope onto the union.
    "lib/api-handler.ts",
    // The MCP edge — the one deliberate `any-valid-token` posture.
    "lib/mcp/auth.ts",
    // The `/mcp` transport, via `resolveMcpAuthContext`.
    "app/mcp/route.ts",
    // Hand-rolled Bearer authentication: the external medication-ingest
    // surface, which gates on BOTH `medication:ingest` and the per-medication
    // `medication:<id>:ingest` grant and never touches `requireAuth`.
    "app/api/ingest/medication/route.ts",
    // `defaultUserIdResolver` — resolves the Bearer token to a user id so an
    // idempotency key files under its owner. It authorises nothing: the
    // handler still runs its own `requireAuth()`, and this resolver only
    // decides which cache cell a replay lands in. Since delegated writes it
    // decides that from two values — the caller resolved here, and the record
    // the request claims, read through the one acting-account carrier reader
    // and folded into the key. Both are unchecked selectors; neither widens
    // what the handler will do. Narrow in reach and deliberate, but it is a
    // raw Bearer value becoming a user id, so it belongs on this list rather
    // than beside it.
    "lib/idempotency.ts",
  ].sort();

  it("no file outside the allowlist resolves a Bearer token to a user", () => {
    // `resolveBearerToken` is the shared primitive; a `tokenHash` lookup is the
    // hand-rolled equivalent. Either one turns a bearer credential into an
    // identity, so both have to stay inside the allowlist.
    //
    // The whitespace classes around `.findUnique` are load-bearing. The
    // original matcher demanded the literal `apiToken.findUnique(`, and
    // `lib/idempotency.ts` writes the call fluent-style — `prisma.apiToken`,
    // newline, `.findUnique({`. It resolved a Bearer token to a user id for
    // three releases without this guard ever seeing it. A matcher that misses
    // a real resolver is green because it matched nothing, not because
    // nothing was there.
    // `tokenHash` may sit anywhere inside the `where` object — demanding it
    // first would let a formatting change (another key ahead of it) walk a
    // resolver out of the guard's sight.
    const resolvers = filesMatching(
      /resolveBearerToken|apiToken\s*\.\s*findUnique\(\s*\{[\s\S]*?where:\s*\{[^}]*?tokenHash/,
    );

    // Non-zero proof: an empty match set must fail rather than agree with an
    // emptied allowlist.
    expect(resolvers.length).toBeGreaterThan(0);
    expect(resolvers).toEqual(RESOLUTION_ALLOWLIST);
  });

  it("the resolver exposes exactly one authorisation arm", () => {
    const src = read("lib/auth/bearer.ts");
    // One wildcard escape hatch, guarding one deny block. If a second
    // `permissions.includes("*")` short-circuit appears, the arm has forked.
    const wildcardChecks = src.match(/permissions\.includes\("\*"\)/g) ?? [];
    expect(wildcardChecks).toHaveLength(1);
  });
});

describe("T2 — `any-valid-token` is the single deliberate fail-open posture", () => {
  it("appears at exactly one call site, and that call site is the MCP edge", () => {
    // `bearer.ts` necessarily names the variant to declare the union; what
    // must stay unique is a caller PASSING it.
    const optedOut = filesMatching(/kind:\s*"any-valid-token"/).filter(
      (rel) => rel !== "lib/auth/bearer.ts",
    );
    expect(optedOut).toEqual(["lib/mcp/auth.ts"]);
  });

  it("no route file opts out of the fail-closed default", () => {
    const routes = sourceFiles().filter((p) => p.endsWith("/route.ts"));
    const optedOut = routes.filter((rel) =>
      /kind:\s*"any-valid-token"/.test(read(rel)),
    );
    expect(optedOut).toEqual([]);
  });
});

describe("T3 — the mint sites are frozen", () => {
  /**
   * Every place an `ApiToken` row is created, with the scope set it may mint.
   * A new mint site, or a new scope on an existing one, has to be named here —
   * which is the point: a user-facing mint that hands out a broad scope is the
   * one failure mode the enforcement change cannot catch by itself.
   */
  const MINT_SITES: Record<string, string> = {
    // Cookie-equivalent. The ONLY `["*"]` mints, all behind a completed login.
    "lib/auth/issue-token.ts": 'opts.permissions ?? ["*"]',
    "lib/auth/login-response.ts": '["*"]',
    "lib/auth/refresh-token.ts": '["*"]',
    "app/api/auth/passkey/login-verify/route.ts": '["*"]',
    // The working medication-ingest pair — family marker plus the per-
    // medication grant that `/api/ingest/medication` actually gates on.
    "app/api/medications/[id]/api-endpoint/route.ts":
      '["medication:ingest", scope]',
    // MCP, audience-bound to `/mcp`. `health:write` requires explicit consent.
    "app/api/mcp/tokens/route.ts": "SCOPE_HEALTH_READ / SCOPE_HEALTH_WRITE",
    "app/api/mcp/oauth/token/route.ts":
      "SCOPE_HEALTH_READ / SCOPE_HEALTH_WRITE",
  };

  it("only the known files create ApiToken rows", () => {
    // Whitespace-tolerant like the T1 resolver matcher — the lesson this
    // very file documents: a prettier-wrapped `apiToken\n  .create({` was
    // invisible to the literal matcher, and a guard that matches nothing
    // is green for the wrong reason.
    const minters = filesMatching(
      /apiToken\s*\.\s*create\s*\(|issueApiToken\s*\(/,
    );
    // Non-zero proof: an empty match set must fail rather than agree with
    // an emptied site table.
    expect(minters.length).toBeGreaterThan(0);
    expect(minters).toEqual(Object.keys(MINT_SITES).sort());
  });

  it("no user-facing mint hands out a wildcard scope", () => {
    // The four `["*"]` mints are all reached only by a completed
    // password / passkey / refresh exchange. Every other mint is narrow.
    const userFacing = [
      "app/api/medications/[id]/api-endpoint/route.ts",
      "app/api/mcp/tokens/route.ts",
      "app/api/mcp/oauth/token/route.ts",
    ];
    for (const rel of userFacing) {
      expect(read(rel)).not.toMatch(/permissions:\s*\[\s*"\*"/);
    }
  });

  it("the retired generic token mint is gone", () => {
    // `POST /api/tokens` minted `["medication:ingest"]` — a token that could
    // not perform its advertised job (it lacked the per-medication grant) and
    // could reach every other authenticated route. List and revoke stay.
    const tokensRoute = read("app/api/tokens/route.ts");
    expect(tokensRoute).not.toMatch(/export const POST/);
    expect(tokensRoute).toMatch(/export const GET/);
  });
});

describe("T4 — declared scopes are exported constants, never string literals", () => {
  it("every requireAuth argument is an identifier", () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      const src = read(rel);
      // Call sites only — skip the declaration in `api-handler.ts`, whose
      // parameter list is not an argument.
      for (const m of src.matchAll(
        /(?<!function\s)requireAuth\(\s*([^)\s][^)]*)\)/g,
      )) {
        const arg = m[1].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(arg)) {
          offenders.push(`${rel}: requireAuth(${arg})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the declared scope vocabulary is closed", () => {
    // Scopes a route may name. Adding one means adding a route that accepts a
    // narrow token, which is a widening — it belongs in a reviewed diff.
    const DECLARED_SCOPES = ["FHIR_READ_SCOPE"];
    const used = new Set<string>();
    for (const rel of sourceFiles()) {
      for (const m of read(rel).matchAll(
        /(?<!function\s)requireAuth\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
      )) {
        used.add(m[1]);
      }
    }
    expect([...used].sort()).toEqual(DECLARED_SCOPES);
  });
});
