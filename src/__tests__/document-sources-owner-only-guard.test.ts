/**
 * The document picker's routes (#1038) are owner-only, cookie-only, and stay
 * that way.
 *
 * A connection is the owner's credential to a system outside HealthLog. A
 * delegate or guardian driving it would read the owner's whole Paperless-ngx or
 * Papra archive, which no grant covers; a Bearer (the native client, a script)
 * has no business managing it either. The rule is in two halves, and this file
 * freezes both at every route module under `src/app/api/documents/sources`:
 *
 *   1. the module calls a bare `requireAuth()` itself (no scope, so a narrow
 *      token is refused, and a request acting on another record is refused
 *      403 `sharing.not_permitted`), and names none of the resolvers that
 *      would admit a delegate, a guardian, or an actor surface;
 *   2. every handler passes the result through `admitDocumentSourceCaller`,
 *      which refuses any transport but the cookie.
 *
 * The scan asserts it found the modules it expects, so an empty directory or a
 * moved tree fails rather than passing on nothing.
 *
 * Mutation checks: swap one route's `requireAuth()` for
 * `requireRecordAuth("write", "documents")`, or drop its
 * `admitDocumentSourceCaller` call, and this file fails naming that module.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "./helpers/source-files";

const ROOT = join(process.cwd(), "src/app/api/documents/sources");

function routeModules(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") out.push(full);
    }
  };
  walk(ROOT);
  return out.map((file) => relative(ROOT, file)).sort();
}

const EXPECTED = [
  "[system]/import/route.ts",
  "[system]/route.ts",
  "[system]/search/route.ts",
  "[system]/tags/route.ts",
  "[system]/test/route.ts",
  "route.ts",
];

describe("document-source routes are owner-only and cookie-only", () => {
  const modules = routeModules();

  it("finds exactly the route modules it freezes", () => {
    expect(modules).toEqual(EXPECTED);
  });

  it.each(EXPECTED)(
    "%s resolves a bare requireAuth and no wider resolver",
    (rel) => {
      const source = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      expect(source).toMatch(/requireAuth\(\s*\)/);
      expect(source).not.toMatch(/requireAuth\(\s*[^)\s]/);
      for (const wider of [
        "requireRecordAuth",
        "requireGuardianAuth",
        "requireActorAuth",
        "requireCookieAuth",
        "requireBearerAuth",
      ]) {
        expect(source, `${rel} names ${wider}`).not.toContain(wider);
      }
    },
  );

  it.each(EXPECTED)(
    "%s admits every handler through the cookie check",
    (rel) => {
      const source = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      const handlers = source.match(
        /export const (GET|POST|PUT|PATCH|DELETE)\b/g,
      );
      expect(handlers?.length ?? 0).toBeGreaterThan(0);
      const auths = source.match(/await requireAuth\(\s*\)/g) ?? [];
      const admits = source.match(/await admitDocumentSourceCaller\(/g) ?? [];
      expect(auths.length).toBe(handlers!.length);
      expect(admits.length).toBe(handlers!.length);
    },
  );

  it("the cookie check refuses every transport but the cookie", () => {
    const support = stripComments(
      readFileSync(
        join(process.cwd(), "src/lib/documents/sources/route-support.ts"),
        "utf8",
      ),
    );
    expect(support).toContain('auth.authMethod !== "cookie"');
    expect(support).toContain('"documents.sources.browserOnly"');
  });
});
