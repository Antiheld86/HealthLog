/**
 * Structural guard: every caller of the doctor-report aggregator is named here
 * with the source of its selection.
 *
 * The aggregator's third parameter is required and brand-typed, so a new
 * egress path cannot compile without naming a selection source. This is the
 * second half of that: it cannot be ADDED without a human writing down which
 * source, in this list, which is the moment a reviewer asks the consent
 * question. Modelled on `bearer-scope-enforcement-guard.test.ts`.
 *
 * Adding a caller fails the build until the list is updated deliberately.
 *
 * Mutation check: add a `collectDoctorReportData(` call anywhere under `src/`
 * that is not in the list → "the set of aggregator callers is frozen" goes red
 * naming the file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");
const SKIP_DIRS = new Set(["__tests__", "node_modules", ".next", "generated"]);

/**
 * Every production call site, with the source of its selection. A path here
 * that no longer calls the aggregator is as much a failure as one that does
 * and is missing — a stale entry is how a list stops being read.
 */
const CALLERS: Record<string, string> = {
  "app/api/export/health-record/route.ts":
    "the request body's `selection` field, minted through selectionFromRequest",
  "lib/clinician-share/share-view-data.ts":
    "the share link's frozen sectionsJson, minted through selectionFromStoredBlob",
  "lib/fhir/rest.ts": "the owner's saved profile (resolveSavedSelection)",
  "lib/mcp/resources.ts": "the owner's saved profile (resolveSavedSelection)",
  "lib/mcp/prompts.ts": "the owner's saved profile (resolveSavedSelection)",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Strip comments so a mention in prose is not read as a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("doctor-report aggregator egress", () => {
  it("keeps the set of aggregator callers frozen", () => {
    const found: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      // The aggregator's own module and its public surface are not callers.
      if (rel === "lib/doctor-report/collect.ts") continue;
      if (rel === "lib/doctor-report-data.ts") continue;
      const body = stripComments(readFileSync(file, "utf8"));
      if (body.includes("collectDoctorReportData(")) found.push(rel);
    }

    const expected = Object.keys(CALLERS).sort();
    expect(
      found.sort(),
      "Every surface that assembles the whole record has to name where its " +
        "selection came from. Add the file to CALLERS with its source, or " +
        "remove the call.",
    ).toEqual(expected);
  });

  it("names a real selection source for each caller", () => {
    for (const [path, source] of Object.entries(CALLERS)) {
      expect(
        source.length,
        `${path} has no stated selection source`,
      ).toBeGreaterThan(10);
    }
  });
});
