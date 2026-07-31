/**
 * Two claims the Health Score panel used to make about its own coverage
 * that were not true, held down structurally so a tidy-up cannot bring
 * either back.
 *
 * **1. `composite.coverage.presentInputs` counts DOMAINS, not pillars.**
 * `computeComposite` builds it from `eligibleDomains.size`. The panel fed
 * it into a sentence reading "{count} eligible pillars", so someone
 * recording blood pressure, glycaemia and lipids was told they had one
 * eligible pillar while looking at three. The count was right; the noun
 * was wrong, and a noun is exactly the thing a later cleanup restores
 * without noticing. The guard reads the call sites out of the AST, so it
 * fails on the value AND on the copy — passing the domain count into a
 * pillar-shaped string is caught wherever the string lives.
 *
 * **2. The composite's coverage fraction is a floor, not a proportion.**
 * `requiredInputs` is the three-domain minimum and `deriveCoverage` clamps
 * `presentInputs` to it, so every scored account rendered "3/3" forever,
 * whatever it records. The arithmetic is right and stays untouched; what
 * was wrong is presenting a met floor as full coverage of the person's own
 * data. The composite's meter therefore names its axis, and the guard
 * fails if that override is dropped.
 *
 * Both are AST matchers rather than text searches, and both carry a
 * counter-test proving they stay quiet on the neighbouring call sites that
 * are legitimately about pillars.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import { CoverageMeter } from "../derived/coverage-meter";
import en from "../../../../messages/en.json";

const CARD_FILE = join(
  process.cwd(),
  "src/components/insights/health-score-card.tsx",
);

function parse(path: string, text?: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    text ?? readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

/** Dotted access path of an expression, or null when it is not one. */
function accessPath(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const base = accessPath(node.expression);
    return base === null ? null : `${base}.${node.name.text}`;
  }
  return null;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Look a dotted i18n key up in the English bundle. */
function message(key: string): string | undefined {
  let cursor: unknown = en;
  for (const segment of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

/**
 * Every `t("some.key", { … })` in `file` that interpolates a value read
 * off `composite.coverage`, paired with the access paths it passed.
 */
function coverageBackedMessages(
  file: ts.SourceFile,
): { key: string; paths: string[] }[] {
  const found: { key: string; paths: string[] }[] = [];
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "t") {
      return;
    }
    const [keyArg, valuesArg] = node.arguments;
    if (!keyArg || !ts.isStringLiteral(keyArg)) return;
    if (!valuesArg || !ts.isObjectLiteralExpression(valuesArg)) return;
    const paths: string[] = [];
    for (const property of valuesArg.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const path = accessPath(property.initializer);
      if (path && path.startsWith("composite.coverage.")) paths.push(path);
    }
    if (paths.length > 0) found.push({ key: keyArg.text, paths });
  });
  return found;
}

/** `<CoverageMeter …>` elements, with the attribute names each carries. */
function coverageMeters(
  file: ts.SourceFile,
): { coverage: string | null; attributes: string[] }[] {
  const found: { coverage: string | null; attributes: string[] }[] = [];
  walk(file, (node) => {
    let opening: ts.JsxOpeningLikeElement | null = null;
    if (ts.isJsxSelfClosingElement(node)) opening = node;
    else if (ts.isJsxElement(node)) opening = node.openingElement;
    if (!opening) return;
    if (opening.tagName.getText(file) !== "CoverageMeter") return;

    const attributes: string[] = [];
    let coverage: string | null = null;
    for (const attribute of opening.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) continue;
      const name = attribute.name.getText(file);
      attributes.push(name);
      if (name !== "coverage") continue;
      const initializer = attribute.initializer;
      if (
        initializer &&
        ts.isJsxExpression(initializer) &&
        initializer.expression
      ) {
        coverage = accessPath(initializer.expression);
      }
    }
    found.push({ coverage, attributes });
  });
  return found;
}

/**
 * The check itself, lifted out so the regression case below runs the very
 * assertions the guard runs rather than an imitation of them.
 */
function checkDomainNoun(site: { key: string; paths: string[] }): void {
  const copy = message(site.key);
  expect(copy, `missing English copy for ${site.key}`).toBeTypeOf("string");
  expect(
    copy,
    `${site.key} interpolates ${site.paths.join(", ")} (a domain count) but reads as pillars`,
  ).not.toMatch(/pillar/i);
  expect(copy, `${site.key} should name the areas it counts`).toMatch(/area/i);
}

describe("the domain count is never described as a pillar count", () => {
  const sites = coverageBackedMessages(parse(CARD_FILE));

  it("finds the call site at all", () => {
    // A matcher that matches nothing passes every assertion below it.
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.map((site) => site.key)).toContain(
      "insights.healthScore.insufficient",
    );
  });

  it("gives every composite-coverage sentence a domain-shaped noun", () => {
    for (const site of sites) checkDomainNoun(site);
  });

  it("stays quiet on a count that really is a count of pillars", () => {
    // The neighbouring `notScored` line passes `notScored.length`, a real
    // pillar count, into copy that says "pillars" and must keep saying so.
    const counterExample = parse(
      "counter-example.tsx",
      `export function X() {
         return <p>{t("insights.healthScore.notScored", { count: notScored.length })}</p>;
       }`,
    );
    expect(coverageBackedMessages(counterExample)).toEqual([]);
    expect(message("insights.healthScore.notScored")).toMatch(/not scored/i);
  });

  it("catches the mislabel when it is reintroduced", () => {
    // The guard's own failure mode, driven through the guard's own check:
    // a domain count fed into a pillar-shaped key is collected, and the
    // check on it throws. `reason.unavailable` is a real shipped string
    // that says "pillar" for a good reason, which is what makes it the
    // right stand-in for the copy this defect produces.
    const regression = parse(
      "regression.tsx",
      `export function X() {
         return <p>{t("insights.healthScore.reason.unavailable", { count: composite.coverage.presentInputs })}</p>;
       }`,
    );
    const collected = coverageBackedMessages(regression);
    expect(collected).toHaveLength(1);
    expect(() => checkDomainNoun(collected[0])).toThrow(/pillar/i);
  });
});

describe("the composite's coverage meter names its own axis", () => {
  const meters = coverageMeters(parse(CARD_FILE));

  it("finds every meter on the panel", () => {
    // Three: the composite's, each scored pillar's, and the weight goal's.
    expect(meters).toHaveLength(3);
  });

  it("overrides the fraction on the composite's meter", () => {
    const composite = meters.filter(
      (meter) => meter.coverage === "composite.coverage",
    );
    expect(composite).toHaveLength(1);
    expect(composite[0].attributes).toContain("axisLabel");
  });

  it("leaves the per-pillar and weight-goal meters alone", () => {
    // Their fractions are real: a pillar's coverage moves with its own
    // inputs, so the default `{present}/{required}` is honest there. The
    // guard must not spread the override to them.
    const others = meters.filter(
      (meter) => meter.coverage !== "composite.coverage",
    );
    expect(others).toHaveLength(2);
    for (const meter of others) {
      expect(meter.attributes).not.toContain("axisLabel");
    }
  });

  it("has copy for both axis labels", () => {
    expect(message("insights.healthScore.coverage.minimumMet")).toMatch(
      /area/i,
    );
    expect(message("insights.healthScore.coverage.areas")).toContain(
      "{present}",
    );
  });
});

/**
 * The attribute guard above proves the override is written down. This
 * proves it does something: a prop that is declared and then ignored is
 * exactly the shape of a check that cannot fail.
 */
describe("the axis override reaches the markup", () => {
  const coverage = {
    requiredInputs: 3,
    presentInputs: 3,
    historyDays: 20,
    missing: [],
  };

  function render(axisLabel?: string): string {
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CoverageMeter coverage={coverage} axisLabel={axisLabel} />
      </I18nProvider>,
    );
  }

  it("replaces the fraction in the label and the accessible name", () => {
    const html = render("Covers the three areas the score needs");

    expect(html).toContain("Covers the three areas the score needs");
    expect(html).not.toContain(">3/3<");
    expect(html).toMatch(/aria-label="Covers the three areas the score needs/);
  });

  it("keeps the fraction for every caller that does not override it", () => {
    const html = render();

    expect(html).toContain("3/3");
    expect(html).toContain("3 of 3 inputs");
  });
});
