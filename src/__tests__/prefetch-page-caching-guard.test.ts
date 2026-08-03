import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guard over the server-prefetching pages.
 *
 * A page that calls `dehydrate()` inside a `HydrationBoundary` serialises a
 * health record into the HTML document and seeds it into the client's query
 * cache. Three things must hold for every such page, and none is enforced by
 * the type system:
 *
 *  1. It must be session-gated at the edge, so `src/proxy.ts` stamps
 *     `Cache-Control: private, no-store` on the document. A prefetching page
 *     placed on a public path would ship a record with no cache directive at
 *     all.
 *  2. It must not opt into static or revalidated rendering. `export const
 *     revalidate = <n>` or `dynamic = "force-static"` would let Next serve one
 *     account's prefetched HTML to the next caller out of its own cache,
 *     before the request ever reaches a header.
 *  3. It must resolve its session through `getUnswitchedSession()`, never
 *     `getSession()`. The first two rules keep one account's record away from
 *     the NEXT caller; this one keeps it away from the CURRENT one. Under an
 *     account switch `getSession()` answers with the delegate — that is its
 *     documented job — so a page that prefetches off it dehydrates the
 *     delegate's own numbers into a document opened on the owner's record.
 *
 * The guard walks the app tree rather than naming files, so a NEW prefetching
 * page is covered the moment it lands. That is the whole point of rule 3 being
 * here rather than a line each page remembers: the five pages that prefetch
 * today all made the same mistake independently, which is what a rule looks
 * like when nothing states it.
 */

const APP_DIR = join(process.cwd(), "src", "app");

/** Mirrors the public-path allowlist in `src/proxy.ts`. */
const PUBLIC_ROUTE_PREFIXES = [
  "/auth/",
  "/privacy",
  "/about",
  "/c/",
  "/invite/",
  "/onboarding",
  "/mcp",
  "/i18n/",
  "/.well-known/",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry === "page.tsx" || entry === "page.ts") {
      out.push(full);
    }
  }
  return out;
}

/** Turn `src/app/insights/workouts/page.tsx` into `/insights/workouts`. */
function routePathFor(file: string): string {
  const rel = relative(APP_DIR, file).split(sep).slice(0, -1);
  const segments = rel.filter(
    // Route groups `(name)` and parallel/intercepting slots contribute no
    // URL segment.
    (s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"),
  );
  return "/" + segments.join("/");
}

function isPublicRoute(routePath: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some((p) => routePath.startsWith(p));
}

const prefetchingPages = walk(APP_DIR)
  .map((file) => ({ file, source: readFileSync(file, "utf8") }))
  .filter(
    ({ source }) =>
      source.includes("HydrationBoundary") && source.includes("dehydrate"),
  )
  .map(({ file, source }) => ({
    file,
    source,
    routePath: routePathFor(file),
    rel: relative(process.cwd(), file),
  }));

describe("server-prefetching pages cannot leak a cacheable record", () => {
  it("finds the prefetching pages at all (guard is not vacuous)", () => {
    expect(prefetchingPages.length).toBeGreaterThan(0);
    // The dashboard is the canonical one; if it stops matching, the detection
    // heuristic has drifted and every assertion below is silently skipped.
    expect(prefetchingPages.map((p) => p.routePath)).toContain("/");
  });

  it("keeps every prefetching page behind the session gate", () => {
    const publicOnes = prefetchingPages.filter((p) =>
      isPublicRoute(p.routePath),
    );
    expect(
      publicOnes.map((p) => `${p.rel} (${p.routePath})`),
      "a page that dehydrates a record onto a public path gets no no-store header from the proxy",
    ).toEqual([]);
  });

  it("lets no prefetching page opt into static or revalidated rendering", () => {
    const offenders: string[] = [];
    for (const page of prefetchingPages) {
      if (/export\s+const\s+revalidate\s*=/.test(page.source)) {
        offenders.push(`${page.rel}: exports revalidate`);
      }
      const dynamicMatch = page.source.match(
        /export\s+const\s+dynamic\s*=\s*["']([^"']+)["']/,
      );
      if (dynamicMatch && dynamicMatch[1] !== "force-dynamic") {
        offenders.push(`${page.rel}: exports dynamic = "${dynamicMatch[1]}"`);
      }
    }
    expect(
      offenders,
      "a prefetched page must never be served from Next's own render cache",
    ).toEqual([]);
  });
});

describe("server-prefetching pages cannot seed a switched session", () => {
  /**
   * Both halves are asserted, and the pair is the guard.
   *
   * "Calls the right helper" alone passes a page that calls both — the import
   * sits there, the accessor is used for a null-check, and the read underneath
   * still goes through `getSession()`. "Does not call the wrong one" alone
   * passes a page that resolves no session at all and prefetches nothing,
   * which is green for a reason nobody wanted. Together they say the one thing
   * meant: the session a prefetching page acts on came from the accessor that
   * refuses under a switch.
   */
  const UNSWITCHED = /\bgetUnswitchedSession\s*\(/;
  const RAW_SESSION = /\bgetSession\s*\(/;

  it("resolves every prefetching page's session through getUnswitchedSession", () => {
    // Non-vacuous, and it has to be said again in this block: `missing` is
    // empty both when every page complies and when the walker found no pages
    // at all. The first describe asserts the same thing, and asserting it once
    // there would let a drifted detector take this leg down with it silently.
    expect(prefetchingPages.length).toBeGreaterThan(0);

    const missing = prefetchingPages
      .filter((p) => !UNSWITCHED.test(p.source))
      .map((p) => p.rel);
    expect(
      missing,
      "a prefetching page must take its session from getUnswitchedSession()",
    ).toEqual([]);
  });

  it("lets no prefetching page reach getSession directly", () => {
    const offenders = prefetchingPages
      .filter((p) => RAW_SESSION.test(p.source))
      .map((p) => p.rel);
    expect(
      offenders,
      "getSession() answers who is CALLING — prefetching off it seeds the delegate's record onto the owner's page",
    ).toEqual([]);
  });
});
