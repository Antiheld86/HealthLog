import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.8.0 — explainer-metric key guard.
 *
 * The sub-page shell builds its i18n lookup from a template literal off
 * the `explainerMetric` prop:
 *
 *   t(`insights.subPage.explainer.${metric}Body`)   // inline definition
 *
 * v1.8.6 — the round `?` popover that also read the `<metric>Title` leaf
 * is gone; the shell now renders only the inline `Body` caption. v1.32.36
 * finished that removal: the `Title` leaves were kept as a "stable, fully
 * populated key pair" reserve, which is translated copy no surface renders,
 * so they were dropped from all six locales and this guard now pins the
 * `Body` leaf alone.
 *
 * The static `i18n-call-site-coverage.test.ts` only sees literal
 * `t("…")` calls, so a typo in an `explainerMetric=` prop would resolve
 * to a missing key and paint the raw key string under the heading — with
 * no CI signal. This test closes that gap the same way the
 * Health-Score provenance key tests pin their dynamic keys: it walks
 * every `explainerMetric="…"` value used under `src/app/insights/**`
 * (plus the shared `healthkit-metric-page` scaffold) and asserts that the
 * `<value>Body` leaf exists in `messages/en.json`.
 * `i18n-locale-integrity.test.ts` then propagates the EN guarantee across
 * the other five locales.
 *
 * v1.15.12 B1 — the score-anatomy detail page (`scores/[metric]/page.tsx`)
 * picks its explainer key at runtime from a closed `Record<…, string>`
 * literal (`explainerMetric={EXPLAINER_METRIC[metric]}`), one of five score
 * suffixes. That single dynamic site is resolved STATICALLY here by parsing
 * the record's string-literal values (the contract stays verifiable).
 */

const ROOT = join(__dirname, "../../../..");
const INSIGHTS_DIR = join(ROOT, "src/app/insights");
const HEALTHKIT_PAGE = join(
  ROOT,
  "src/components/insights/healthkit-metric-page.tsx",
);
const EN_BUNDLE_PATH = join(ROOT, "messages/en.json");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      walk(p, out);
    } else if (name.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

interface PropSite {
  value: string;
  file: string;
  line: number;
}

// Match `explainerMetric="someValue"` — a string-literal prop. The
// component contract accepts a static string, OR the single closed-record
// lookup on the score-anatomy page (resolved statically below).
const LITERAL_PATTERN = /explainerMetric="([a-zA-Z][a-zA-Z0-9]*)"/g;
const DYNAMIC_PATTERN = /explainerMetric=\{/;

// v1.15.12 B1 — the one allowed dynamic site: the score-anatomy detail page
// reads its explainer key from a closed `EXPLAINER_METRIC` record literal.
// We resolve it statically — parse the record's string-literal values — so
// the dynamic site stays verifiable rather than escaping the guard.
const SCORES_PAGE = "src/app/insights/scores/[metric]/page.tsx";
const RECORD_LOOKUP_PATTERN = /explainerMetric=\{([A-Z_][A-Za-z0-9_]*)\[/;
const RECORD_VALUE_PATTERN = /:\s*"([a-zA-Z][a-zA-Z0-9]*)"/g;

/** Resolve a closed `const NAME = { … "value" … }` record's string values. */
function resolveRecordValues(source: string, recordName: string): string[] {
  const start = source.indexOf(`const ${recordName}`);
  if (start === -1) return [];
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  if (open === -1 || close === -1) return [];
  const body = source.slice(open + 1, close);
  const values: string[] = [];
  let m: RegExpExecArray | null;
  RECORD_VALUE_PATTERN.lastIndex = 0;
  while ((m = RECORD_VALUE_PATTERN.exec(body)) !== null) values.push(m[1]);
  return values;
}

function collectSites(): { sites: PropSite[]; dynamic: PropSite[] } {
  const files = [...walk(INSIGHTS_DIR), HEALTHKIT_PAGE];
  const sites: PropSite[] = [];
  const dynamic: PropSite[] = [];
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1);
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // The scaffold declares + forwards the prop; ignore the type
      // declaration + the pass-through (`explainerMetric={explainerMetric}`)
      // — those are not call sites that pin a concrete key.
      if (file === HEALTHKIT_PAGE) continue;
      let m: RegExpExecArray | null;
      LITERAL_PATTERN.lastIndex = 0;
      while ((m = LITERAL_PATTERN.exec(line)) !== null) {
        sites.push({ value: m[1], file: rel, line: i + 1 });
      }
      if (DYNAMIC_PATTERN.test(line)) {
        // The score-anatomy record lookup is statically resolvable; every
        // resolved value becomes a site. Any OTHER dynamic shape is
        // unverifiable and trips the no-dynamic guard.
        const lookup = RECORD_LOOKUP_PATTERN.exec(line);
        if (file.endsWith(SCORES_PAGE) && lookup) {
          for (const value of resolveRecordValues(source, lookup[1])) {
            sites.push({ value, file: rel, line: i + 1 });
          }
        } else {
          dynamic.push({ value: line.trim(), file: rel, line: i + 1 });
        }
      }
    }
  }
  return { sites, dynamic };
}

function hasLeaf(obj: unknown, dotted: string): boolean {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (
      cur &&
      typeof cur === "object" &&
      part in (cur as Record<string, unknown>)
    ) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return false;
    }
  }
  return typeof cur === "string";
}

describe("insights explainerMetric key coverage", () => {
  const en = JSON.parse(readFileSync(EN_BUNDLE_PATH, "utf8"));
  const { sites, dynamic } = collectSites();

  it("finds explainerMetric props across the insights pages", () => {
    // Guards against the walker silently matching nothing (e.g. a refactor
    // that renames the prop). The category surface carries dozens of pages.
    expect(sites.length).toBeGreaterThan(20);
  });

  it("uses only string-literal explainerMetric props (no dynamic expressions)", () => {
    // A dynamic value can't be statically verified against the bundle, so
    // the contract is literal-only. If this ever fails, either inline the
    // literal or extend this guard to resolve the expression.
    expect(dynamic).toEqual([]);
  });

  it("every explainerMetric value resolves a Body leaf in messages/en.json", () => {
    const missing: string[] = [];
    for (const site of sites) {
      const bodyKey = `insights.subPage.explainer.${site.value}Body`;
      if (!hasLeaf(en, bodyKey)) {
        missing.push(`  ❌ ${bodyKey}  (${site.file}:${site.line})`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Found ${missing.length} explainerMetric key(s) missing from messages/en.json:\n${missing.join("\n")}`,
      );
    }
  });
});
