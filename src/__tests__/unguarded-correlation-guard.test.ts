/**
 * Structural guard on the unguarded Pearson helper.
 *
 * `pearsonCorrelation` bands a coefficient from |r| alone above a floor of
 * five pairs, with no significance test. Its guarded twin
 * `significantPearsonCorrelation` sits directly beneath it in the same file
 * and exists because of exactly one failure: five days of noise sloping the
 * right way reaching a reader labelled "strong". The comment above the twin
 * says so in as many words.
 *
 * The twin was written once and adopted one surface at a time, which is how
 * the mood page kept the naive call for four minor lines after the surfaces
 * either side of it had moved. Nothing failed when it was skipped, because
 * nothing was watching. This is what watches: a new caller of the unguarded
 * helper has to be added to the list below, in a diff a reviewer reads, next
 * to a written reason.
 *
 * It is a tripwire, not a proof. It cannot say the remaining entries are
 * right — only that the set has not grown without someone editing this file.
 * The two entries it carries today are named as open work, not as blessings.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * Files that may still call `pearsonCorrelation` directly, and why.
 *
 * Neither entry is settled. Both are the same migration the user-facing
 * surfaces already made, still owed by two payload builders whose consumers
 * pin the n >= 5 shape; moving them changes what those payloads contain and
 * belongs in its own change with its own tests, not smuggled into this one.
 */
const ALLOWED: Record<string, string> = {
  "app/api/insights/comprehensive/route.ts":
    "Five correlations on the /insights envelope (weight x BP, mood x BP, " +
    "mood x weight, mood x pulse, BP-medication continuity). Open: they " +
    "carry the same small-n exposure the mood page had, and the page's " +
    "cards read `n` straight off the envelope.",
  "lib/insights/features.ts":
    "Eight cross-metric coefficients on the AI feature payload. Open: the " +
    "prompt reads them as findings, so the same significance bar applies; " +
    "the snapshot shape and its budget tests move with it.",
};

/** Every non-test, non-generated source file under `src/`. */
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

/**
 * A call to the unguarded helper. Whitespace-tolerant and anchored on a word
 * boundary so `significantPearsonCorrelation(` cannot match: a matcher that
 * quietly matches nothing is the failure mode this repository has shipped
 * before, so the count is asserted below as well.
 */
const CALL = /(?<![A-Za-z])pearsonCorrelation\s*\(/;

describe("the unguarded Pearson helper has a closed caller set", () => {
  it("finds callers at all, so an empty result cannot read as a pass", () => {
    const definition = read("lib/analytics/correlations.ts");
    expect(definition).toMatch(/export function pearsonCorrelation\s*\(/);
    expect(
      definition,
      "the guarded twin must exist for this guard to mean anything",
    ).toMatch(/export function significantPearsonCorrelation\s*\(/);

    const callers = sourceFiles().filter(
      (rel) => rel !== "lib/analytics/correlations.ts" && CALL.test(read(rel)),
    );
    expect(callers.length).toBeGreaterThan(0);
  });

  it("names every caller outside the allowlist", () => {
    const callers = sourceFiles().filter(
      (rel) => rel !== "lib/analytics/correlations.ts" && CALL.test(read(rel)),
    );

    expect(
      callers.filter((rel) => !(rel in ALLOWED)),
      "A new caller of the unguarded `pearsonCorrelation`. A surface a " +
        "person reads must use `significantPearsonCorrelation` (n >= 20 " +
        "AND p < 0.05). If this one genuinely cannot, add it to ALLOWED " +
        "in this file with the reason, so the exception is reviewed rather " +
        "than assumed.",
    ).toEqual([]);
  });

  it("keeps the allowlist honest by refusing stale entries", () => {
    const callers = new Set(
      sourceFiles().filter(
        (rel) =>
          rel !== "lib/analytics/correlations.ts" && CALL.test(read(rel)),
      ),
    );

    // An entry whose file no longer calls the helper is a licence nobody
    // needs any more; leaving it standing is how the next one gets waved in.
    expect(
      Object.keys(ALLOWED).filter((rel) => !callers.has(rel)),
      "this file is on the allowlist but no longer calls the unguarded " +
        "helper — drop the entry",
    ).toEqual([]);
  });
});
