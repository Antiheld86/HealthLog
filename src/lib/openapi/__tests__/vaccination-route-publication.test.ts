/**
 * Every vaccination route that exists on disk is published in the
 * OpenAPI route table.
 *
 * The iOS tracker was told the booster mint and the upload suggestion
 * were in the spec while neither was registered — the one false
 * statement to the client. This guard recomputes the expected path set
 * from the route files themselves, so the next vaccination route
 * cannot ship unpublished either.
 *
 * Watched red: with the `/api/vaccinations/{id}/booster` and
 * `/api/vaccinations/suggest` entries removed from `vaccinationPaths`
 * this fails naming both paths — the exact pre-fix state.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { vaccinationPaths } from "../routes/vaccinations";

const ROUTE_ROOT = join(__dirname, "../../../app/api/vaccinations");

/** Collect every route.ts under the vaccinations API tree as a spec path. */
function collectRoutePaths(dir: string, urlPrefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Next dynamic segment `[id]` publishes as `{id}`.
      const segment = entry.replace(/^\[(.+)\]$/, "{$1}");
      found.push(...collectRoutePaths(full, `${urlPrefix}/${segment}`));
    } else if (entry === "route.ts") {
      found.push(urlPrefix);
    }
  }
  return found;
}

describe("vaccination route publication", () => {
  it("publishes every vaccination route file", () => {
    const expected = collectRoutePaths(ROUTE_ROOT, "/api/vaccinations").sort();
    // Self-check: the walker found the tree (an empty set proves nothing).
    expect(expected.length).toBeGreaterThanOrEqual(6);
    const published = Object.keys(vaccinationPaths).sort();
    const missing = expected.filter((p) => !published.includes(p));
    expect(
      missing,
      "vaccination route files without an OpenAPI path entry — register them in src/lib/openapi/routes/vaccinations.ts and run pnpm openapi:generate",
    ).toEqual([]);
  });

  it("publishes the booster mint and the upload suggestion with their verbs", () => {
    expect(
      vaccinationPaths["/api/vaccinations/{id}/booster"]?.post,
    ).toBeDefined();
    expect(vaccinationPaths["/api/vaccinations/suggest"]?.get).toBeDefined();
  });
});
