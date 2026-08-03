import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every audit action a delegable write route emits has a verb line.
 *
 * The owner's activity view exists to answer "what did somebody else do in my
 * record". It answers that by mapping the audit action to a sentence, and
 * falling back to "made a change" for anything unmapped. A fallback is the
 * right behaviour for an action nobody anticipated; it is the wrong behaviour
 * for the actions this release deliberately admits.
 *
 * That is not hypothetical. The map was written against the action name the
 * canonical route uses, while the web client posts to a sibling route that has
 * audited under a different name since v1.0.0 — so the single most-used
 * delegated act, a caregiver marking a dose, rendered as the generic fallback
 * for the person whose tablets they are. Nothing failed; the sentence was just
 * vaguer than it needed to be, which is exactly the kind of defect no
 * behavioural test notices.
 *
 * So this reads the actions out of the routes rather than out of a list
 * somebody maintains beside them. A new delegable write whose action has no
 * sentence fails here, at the moment it is added.
 */
const API = join(process.cwd(), "src/app/api");
const VERB_MAP = join(
  process.cwd(),
  "src/lib/record-activity/activity-verb.ts",
);

/** Every `route.ts` under `src/app/api`, walked rather than globbed: a glob's
 *  `*` skips a leading dot and this tree has dot-directories. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

describe("the owner's activity view names what a delegate did", () => {
  const routes = routeFiles(API);

  it("reads a plausible number of route modules", () => {
    // A walk that finds nothing agrees with a map that covers nothing.
    expect(routes.length).toBeGreaterThan(300);
  });

  it("gives every delegable write action its own sentence", () => {
    const map = readFileSync(VERB_MAP, "utf8");

    const unmapped: string[] = [];
    for (const file of routes) {
      const src = readFileSync(file, "utf8");
      if (!src.includes('requireRecordAuth("write")')) continue;
      // The awaited success-path audits only. A fire-and-forget breadcrumb on a
      // validation failure is not something to narrate to the owner.
      for (const m of src.matchAll(/await auditLog\(\s*"([^"]+)"/g)) {
        const action = m[1];
        if (!map.includes(`case "${action}"`)) unmapped.push(`${action}`);
      }
    }

    expect(
      [...new Set(unmapped)].sort(),
      "a delegable write whose audit action has no verb line renders to the " +
        "owner as the generic 'made a change'. Add a case to activity-verb.ts " +
        "and a string to all six bundles.",
    ).toEqual([]);
  });
});
