import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AI_ROUTES,
  AI_ROUTE_TREES,
  DATA_ROUTES,
  PENDING_ROUTES,
} from "../../__tests__/ai-route-inventory";

/**
 * Every route in the trees where AI routes live is classified.
 *
 * This file used to sort the `/api/insights` routes into "Coach-gated",
 * "other-gated" and "not Coach-owned" by the operator switch each one read.
 * That sorting encoded the defect the AI-optional design removes: ECG uploads,
 * rhythm events, scores and correlation statistics sat behind AI switches, so
 * turning AI off took data down with it. The rule now is the capability rule:
 *
 *   - a data route asks no AI capability and is never refused for an AI
 *     reason;
 *   - an AI route names its capability (`requireAiCapability` for an action,
 *     `getAiCapability` for a mixed read).
 *
 * The lists live in `src/app/api/__tests__/ai-route-inventory.ts`; the whole
 * API tree is checked against them by `ai-capability-route-inventory.test.ts`.
 * This file walks the insights, Coach and daily trees and fails by name on any
 * route that none of the lists classifies, so a new route there has to decide
 * which kind it is. `PENDING_ROUTES` names the few whose AI gating another
 * change owns; an entry there that starts asking a capability fails until it
 * moves to `AI_ROUTES`.
 *
 * Mutation checks: deleting `insights/ecg/route.ts` from `DATA_ROUTES` fails
 * the orphan test by name; adding `getAiCapability("coach")` to a pending
 * route fails the pending test; pointing the walk at an empty tree fails the
 * count.
 */

const repoRoot = resolve(__dirname, "..", "..", "..", "..", "..");

function routeFiles(tree: string): string[] {
  const hits: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        walk(full);
      } else if (entry === "route.ts") {
        hits.push(relative(repoRoot, full).split(/[\\/]/).join("/"));
      }
    }
  }
  walk(resolve(repoRoot, tree));
  return hits;
}

const ROUTES = AI_ROUTE_TREES.flatMap(routeFiles).sort();

const ANY_GATE =
  /\b(?:requireAiCapability|getAiCapability|aiCapabilityToServe)\s*\(/;

function code(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

describe("insights, Coach and daily route classification", () => {
  it("walks trees that exist and finds routes in them", () => {
    for (const tree of AI_ROUTE_TREES) {
      expect(existsSync(resolve(repoRoot, tree)), tree).toBe(true);
    }
    expect(ROUTES.length).toBeGreaterThan(40);
  });

  it("classifies every route as AI, data or pending", () => {
    const orphans = ROUTES.filter(
      (path) =>
        !(path in AI_ROUTES) &&
        !(path in DATA_ROUTES) &&
        !(path in PENDING_ROUTES),
    );
    expect(
      orphans,
      [
        "Unclassified routes. Decide what each one is and add it to",
        "src/app/api/__tests__/ai-route-inventory.ts:",
        "  AI_ROUTES — it calls a model or serves model text (name the capability);",
        "  DATA_ROUTES — it serves or accepts data and must never ask AI.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("classifies no route twice", () => {
    const lists = [AI_ROUTES, DATA_ROUTES, PENDING_ROUTES].map((list) =>
      Object.keys(list),
    );
    const seen = new Map<string, number>();
    for (const list of lists) {
      for (const path of list) seen.set(path, (seen.get(path) ?? 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1).map(([path]) => path)).toEqual(
      [],
    );
  });

  it("keeps PENDING_ROUTES honest: existing files, none of them asking yet", () => {
    for (const path of Object.keys(PENDING_ROUTES)) {
      expect(ROUTES, `${path} no longer exists`).toContain(path);
      expect(
        ANY_GATE.test(code(path)),
        `${path} now asks an AI capability — move it to AI_ROUTES`,
      ).toBe(false);
    }
  });
});
