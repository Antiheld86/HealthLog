/**
 * The write-time refusal has two ends, and this holds them together.
 *
 * The server owns the breadth rule and answers a too-narrow selection
 * with a machine reason in `meta.reason`. The settings surface turns that
 * reason into a sentence in the reader's own language. Nothing in the
 * type system connects the two: rename a reason on the route, and the
 * client silently falls through to "couldn't save, try again" while the
 * person is left with no idea what is wrong with their selection. That is
 * a refusal that stops refusing anything in particular, and it looks
 * perfectly healthy in every unit test on either side.
 *
 * So: the reasons the rule can produce, the reasons the route has copy
 * for, and the reasons the client has copy for must be the same set. The
 * rule's own list is read out of `breadth.ts` rather than restated here,
 * because a restated list is a fourth place to forget.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import en from "../../../../messages/en.json";
import { REFUSAL_KEYS } from "../score-section";

const ROOT = process.cwd();
const RULE_FILE = join(ROOT, "src/lib/analytics/score/breadth.ts");
const ROUTE_FILE = join(
  ROOT,
  "src/app/api/auth/me/health-score-config/route.ts",
);

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** The string members of an exported union type alias. */
function unionMembers(file: ts.SourceFile, name: string): string[] {
  const members: string[] = [];
  walk(file, (node) => {
    if (!ts.isTypeAliasDeclaration(node)) return;
    if (node.name.text !== name) return;
    const type = node.type;
    const parts = ts.isUnionTypeNode(type) ? type.types : [type];
    for (const part of parts) {
      if (
        ts.isLiteralTypeNode(part) &&
        ts.isStringLiteral(part.literal) &&
        part.literal.text.length > 0
      ) {
        members.push(part.literal.text);
      }
    }
  });
  return members;
}

/** The property names of a top-level object-literal constant. */
function objectKeys(file: ts.SourceFile, name: string): string[] {
  const keys: string[] = [];
  walk(file, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== name) return;
    let initializer = node.initializer;
    while (
      initializer &&
      (ts.isAsExpression(initializer) ||
        ts.isSatisfiesExpression(initializer) ||
        ts.isParenthesizedExpression(initializer))
    ) {
      initializer = initializer.expression;
    }
    if (!initializer || !ts.isObjectLiteralExpression(initializer)) return;
    for (const property of initializer.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const propertyName = property.name;
      if (ts.isIdentifier(propertyName)) keys.push(propertyName.text);
      else if (ts.isStringLiteral(propertyName)) keys.push(propertyName.text);
    }
  });
  return keys;
}

function message(key: string): string | undefined {
  let cursor: unknown = en;
  for (const segment of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

const ruleReasons = unionMembers(parse(RULE_FILE), "ScoreBreadthFailure");
const routeReasons = objectKeys(parse(ROUTE_FILE), "BREADTH_REFUSAL");

describe("every refusal the rule can give reaches the reader", () => {
  it("reads the rule's own list rather than a copy of it", () => {
    // A matcher that finds nothing agrees with everything. The anchor
    // moved from `three_domains_required` to `no_pillars_selected` in
    // v1.38: three areas of health stopped being the price of a score,
    // so the write stopped refusing narrow selections and the only
    // refusal left is the empty one.
    expect(ruleReasons.length).toBeGreaterThan(0);
    expect(ruleReasons).toContain("no_pillars_selected");
  });

  it("gives the route a sentence for each of them", () => {
    expect([...routeReasons].sort()).toEqual([...ruleReasons].sort());
  });

  it("gives the settings surface localised copy for each of them", () => {
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual([...ruleReasons].sort());
  });

  it("resolves every one of those keys to real copy", () => {
    for (const [reason, key] of Object.entries(REFUSAL_KEYS)) {
      const copy = message(key);
      expect(copy, `${reason} → ${key}`).toBeTypeOf("string");
      expect(copy?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("stays quiet on a constant that is not the refusal map", () => {
    // The matcher is name-anchored, not shape-anchored: it must not pick
    // up the neighbouring object literals on either file and quietly
    // widen what the comparison above is comparing.
    expect(objectKeys(parse(ROUTE_FILE), "NOT_A_REAL_CONSTANT")).toEqual([]);
    expect(unionMembers(parse(RULE_FILE), "NotARealType")).toEqual([]);
  });
});
