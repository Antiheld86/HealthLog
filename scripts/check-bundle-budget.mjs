#!/usr/bin/env node
/**
 * Client-bundle report + budget gate for the Turbopack build.
 *
 * The webpack-era tooling died on Next 16: `ANALYZE=1` is a silent no-op
 * under Turbopack and the old `.next/analyze/client.json` reader had
 * nothing to read — so bundle regressions (a statically imported message
 * catalog, a duplicated recharts chunk group) shipped invisibly. This
 * script derives the signal straight from the build output instead:
 *
 *   - per-route client-JS totals (gzip) from the Turbopack
 *     `*_client-reference-manifest.js` files plus the shared
 *     `rootMainFiles` baseline from `build-manifest.json`;
 *   - the total gzip weight of every emitted client chunk;
 *   - a recharts-duplication guard: the number of chunks carrying the
 *     recharts library fingerprint must stay exactly 1 (the shared
 *     chart-runtime chunk group);
 *   - a catalog guard: no message-catalog-fingerprinted chunk may be
 *     referenced by any route's client-reference manifest or by the
 *     shared baseline (catalogs load only lazily / via /i18n/<locale>).
 *
 * Usage:
 *   pnpm bundle-report            # print the report table
 *   pnpm bundle-report --check    # enforce bundle-budget.json (CI gate)
 *
 * Budgets live in `bundle-budget.json` (repo root). Numbers are KB gzip
 * with deliberate headroom over the measured value — the gate exists to
 * catch step-change regressions (a ~100 KB catalog, a ~90 KB duplicate
 * library), not day-to-day noise. Raise a budget consciously, in the same
 * PR that pays the cost, with the reason in the PR body.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const CHECK = process.argv.includes("--check");
const BUILD_DIR = join(process.cwd(), ".next");
const APP_DIR = join(BUILD_DIR, "server", "app");
const BUDGET_PATH = join(process.cwd(), "bundle-budget.json");

if (!existsSync(join(BUILD_DIR, "build-manifest.json"))) {
  console.error(
    "check-bundle-budget: no .next/build-manifest.json — run `pnpm build` first.",
  );
  process.exit(2);
}

/** Recharts library fingerprint (present once in the shared runtime chunk). */
const RECHARTS_MARK = "CartesianGrid";
/**
 * Message-catalog fingerprint. The key set is identical across all six
 * locales, so a KEY-position match ("typeTimeInDaylight" directly followed
 * by a colon, in either the plain or the JSON.parse-escaped chunk encoding)
 * marks a bundled catalog. Source modules only ever carry the namespaced
 * call-site form (`measurements.typeTimeInDaylight`), which matches neither.
 */
const CATALOG_MARKS = ['"typeTimeInDaylight":', 'typeTimeInDaylight\\":'];

const sizeCache = new Map();
function chunkInfo(file) {
  if (!sizeCache.has(file)) {
    try {
      const buf = readFileSync(join(BUILD_DIR, file));
      sizeCache.set(file, {
        raw: buf.length,
        gz: gzipSync(buf, { level: 9 }).length,
        recharts: buf.includes(RECHARTS_MARK),
        catalog: CATALOG_MARKS.some((m) => buf.includes(m)),
      });
    } catch {
      sizeCache.set(file, { raw: 0, gz: 0, recharts: false, catalog: false });
    }
  }
  return sizeCache.get(file);
}

function routeChunks(manifestFile) {
  const src = readFileSync(manifestFile, "utf8");
  const idx = src.indexOf("= {");
  const json = JSON.parse(src.slice(idx + 2).replace(/;\s*$/, ""));
  const files = new Set();
  for (const key of Object.keys(json.clientModules ?? {})) {
    for (const chunk of json.clientModules[key].chunks ?? []) {
      if (chunk.endsWith(".js")) files.add(chunk.replace(/^\/_next\//, ""));
    }
  }
  return files;
}

function findRouteManifests(dir, prefix = "") {
  let out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(findRouteManifests(p, `${prefix}/${entry.name}`));
    } else if (entry.name.endsWith("_client-reference-manifest.js")) {
      out.push({
        route: `${prefix}/${entry.name.replace("_client-reference-manifest.js", "")}`,
        file: p,
      });
    }
  }
  return out;
}

const kb = (bytes) => bytes / 1024;
const fmt = (bytes) => `${kb(bytes).toFixed(0)} KB`;

// ── Shared baseline ─────────────────────────────────────────────────────────
const buildManifest = JSON.parse(
  readFileSync(join(BUILD_DIR, "build-manifest.json"), "utf8"),
);
const rootFiles = buildManifest.rootMainFiles ?? [];
let rootGz = 0;
for (const f of rootFiles) rootGz += chunkInfo(f).gz;

// ── Per-route totals ────────────────────────────────────────────────────────
const manifests = findRouteManifests(APP_DIR);
const routeTotals = new Map();
for (const { route, file } of manifests) {
  let gz = 0;
  let catalogRef = false;
  for (const chunk of routeChunks(file)) {
    const info = chunkInfo(chunk);
    gz += info.gz;
    if (info.catalog) catalogRef = true;
  }
  routeTotals.set(route, { gz: gz + rootGz, catalogRef });
}

// ── Whole-build chunk scan ──────────────────────────────────────────────────
const chunkDir = join(BUILD_DIR, "static", "chunks");
let totalGz = 0;
let rechartsChunks = 0;
let catalogChunks = 0;
let catalogGz = 0;
let largest = { file: "-", gz: 0 };
for (const f of readdirSync(chunkDir)) {
  if (!f.endsWith(".js")) continue;
  const info = chunkInfo(join("static", "chunks", f));
  totalGz += info.gz;
  if (info.recharts) rechartsChunks += 1;
  if (info.catalog) {
    catalogChunks += 1;
    catalogGz += info.gz;
  }
  if (info.gz > largest.gz) largest = { file: f, gz: info.gz };
}
const rootCatalogRef = rootFiles.some((f) => chunkInfo(f).catalog);

// ── Report ──────────────────────────────────────────────────────────────────
const budget = existsSync(BUDGET_PATH)
  ? JSON.parse(readFileSync(BUDGET_PATH, "utf8"))
  : null;

console.log(`shared baseline (rootMainFiles): ${fmt(rootGz)} gz`);
console.log(`all client chunks:               ${fmt(totalGz)} gz`);
console.log(
  `  lazy message catalogs:         ${fmt(catalogGz)} gz  (${catalogChunks} chunks)`,
);
console.log(`  other client chunks:           ${fmt(totalGz - catalogGz)} gz`);
console.log(
  `largest chunk:                   ${fmt(largest.gz)} gz  ${largest.file}`,
);
console.log(`recharts-fingerprint chunks:     ${rechartsChunks}`);
console.log("");

const watched = budget ? Object.keys(budget.routesKbGz ?? {}) : [];
const rows = [...routeTotals.entries()]
  .filter(([route]) => !watched.length || watched.includes(route))
  .sort((a, b) => b[1].gz - a[1].gz);
for (const [route, { gz }] of rows.slice(0, watched.length || 15)) {
  const cap = budget?.routesKbGz?.[route];
  console.log(
    `${fmt(gz).padStart(8)} gz  ${route}${cap ? `  (budget ${cap} KB)` : ""}`,
  );
}

if (!CHECK) process.exit(0);

// ── Budget gate ─────────────────────────────────────────────────────────────
if (!budget) {
  console.error("check-bundle-budget: bundle-budget.json missing.");
  process.exit(2);
}

const failures = [];
for (const [route, capKb] of Object.entries(budget.routesKbGz ?? {})) {
  const actual = routeTotals.get(route);
  if (!actual) {
    failures.push(`route ${route} not found in the build output`);
    continue;
  }
  if (kb(actual.gz) > capKb) {
    failures.push(
      `${route}: ${fmt(actual.gz)} gz exceeds the ${capKb} KB budget`,
    );
  }
}
if (budget.totalClientKbGz && kb(totalGz) > budget.totalClientKbGz) {
  failures.push(
    `total client JS ${fmt(totalGz)} gz exceeds the ${budget.totalClientKbGz} KB budget`,
  );
}
if (
  budget.maxRechartsChunks != null &&
  rechartsChunks > budget.maxRechartsChunks
) {
  failures.push(
    `${rechartsChunks} recharts-fingerprint chunks (budget ${budget.maxRechartsChunks}) — a chart import bypassed the shared chart-runtime boundary`,
  );
}
const catalogRefRoutes = [...routeTotals.entries()]
  .filter(([, v]) => v.catalogRef)
  .map(([r]) => r);
if (catalogRefRoutes.length > 0 || rootCatalogRef) {
  failures.push(
    `message catalog statically referenced by ${rootCatalogRef ? "the shared baseline" : catalogRefRoutes.join(", ")} — catalogs must stay lazy (/i18n/<locale> + dynamic import)`,
  );
}

if (failures.length > 0) {
  console.error("\nBundle budget check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nBundle budget check passed.");
