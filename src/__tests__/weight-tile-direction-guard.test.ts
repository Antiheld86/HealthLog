/**
 * The dashboard weight tile colours its trend by the resolved target
 * direction, never by a literal (#1006).
 *
 * Every other tile on the strip passes a literal `directionSentiment`, because
 * for resting pulse or steps the good direction is a property of the metric.
 * Weight is the exception: which way is progress depends on the person's own
 * target, and it is resolved on the server (`tiles.weightTrend` on the
 * snapshot, `src/lib/targets/weight-trend.ts`). A literal `"up-bad"` here is
 * exactly the defect the issue reported — a person below their target saw
 * every gain coloured as a setback — and it would type-check and render
 * without complaint, so this pins the attribute rather than the pixels.
 *
 * Structural rather than rendered because the dashboard page early-returns a
 * loading gate under SSR, and the property is about the source: the weight
 * `<TrendCard>` names `weightTrend.direction`, or it does not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const PAGE = join(process.cwd(), "src/app/page-client.tsx");

function weightTileDirections(): string[] {
  const text = readFileSync(PAGE, "utf8");
  const file = ts.createSourceFile(
    PAGE,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(file) === "TrendCard"
    ) {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const key = attrs.find((a) => a.name.getText(file) === "key");
      const isWeight =
        key?.initializer &&
        ts.isStringLiteral(key.initializer) &&
        key.initializer.text === "weight";
      if (isWeight) {
        const direction = attrs.find(
          (a) => a.name.getText(file) === "directionSentiment",
        );
        found.push(direction?.initializer?.getText(file) ?? "<absent>");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("dashboard weight tile direction", () => {
  it("finds exactly one weight tile, so an empty match cannot pass", () => {
    expect(weightTileDirections()).toHaveLength(1);
  });

  it("reads the resolved target direction rather than a literal", () => {
    expect(weightTileDirections()).toEqual(["{weightTrend.direction}"]);
  });
});
