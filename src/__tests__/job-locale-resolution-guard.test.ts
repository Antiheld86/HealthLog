/**
 * Structural guard: a job or worker resolves a user row's locale through
 * `resolveJobLocale`, never through a bare fallback to English.
 *
 * Background paths have no request, so nothing but the stored `User.locale`
 * tells them which language to write in. When that column is NULL the old
 * hand-rolled coercions (`locales.includes(x) ? x : defaultLocale`,
 * `normalizeLocale(user.locale)`) all landed on English, and the operator's
 * configured default locale was never consulted. The nightly briefing warm
 * then wrote English prose into a cache that a German reader was served from.
 *
 * `resolveJobLocale` is the one place the fallback order lives: stored user
 * locale, then the operator default, then English. This guard keeps every
 * job path on it. Three tripwires, none of them a proof:
 *
 *   T1 — no file under `src/lib/jobs` or `src/lib/daily` hand-rolls the
 *        coercion with `locales.includes(`.
 *   T2 — no such file applies `normalizeLocale` / `coerceLocale` /
 *        `resolveLocale` straight to a row column (`<row>.locale`). Those
 *        validators are for a value that is already resolved, such as a job
 *        payload.
 *   T3 — every such file that reads a row's `.locale` imports the helper.
 *
 * What slips past: a row column read into a local variable first and then
 * coerced, or handed raw to a template function whose parameter still
 * accepts `string | null`. The matchers are grep-shaped on purpose; a
 * reviewer still reads the diff.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const ROOTS = ["lib/jobs", "lib/daily"] as const;

function jobFiles(): string[] {
  return ROOTS.flatMap((root) =>
    walkSourceFiles(join(SRC, root), { floor: 5 })
      .filter((rel) => !rel.includes("__tests__"))
      .filter((rel) => !rel.endsWith(".test.ts"))
      .map((rel) => `${root}/${rel}`),
  ).sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/**
 * Receivers whose `.locale` is a value already resolved upstream — a queue
 * payload, an options bag, a template input — rather than a database row.
 */
const RESOLVED_RECEIVERS = new Set([
  "data",
  "payload",
  "options",
  "opts",
  "input",
  "params",
  "prepared",
  "job",
]);

const ROW_LOCALE_READ = /\b([A-Za-z_$][\w$]*)\??\.locale\b(?!\s*[:=][^=])/g;

function rowLocaleReceivers(text: string): string[] {
  const receivers = new Set<string>();
  for (const match of text.matchAll(ROW_LOCALE_READ)) {
    const receiver = match[1];
    if (RESOLVED_RECEIVERS.has(receiver)) continue;
    receivers.add(receiver);
  }
  return [...receivers].sort();
}

describe("job-side locale resolution goes through resolveJobLocale", () => {
  const files = jobFiles();

  it("walks a non-trivial set of job and daily files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("T1 — no job file hand-rolls the locale coercion with locales.includes(", () => {
    const offenders = files.filter((rel) =>
      /\blocales\.includes\(/.test(read(rel)),
    );
    expect(offenders).toEqual([]);
  });

  it("T2 — no job file applies a bare validator to a row's locale column", () => {
    const bare =
      /\b(?:normalizeLocale|coerceLocale|resolveLocale)\(\s*(?:[\w$]+\.)*([\w$]+)\??\.locale\s*\)/g;
    const offenders = files.filter((rel) =>
      [...read(rel).matchAll(bare)].some(
        (match) => !RESOLVED_RECEIVERS.has(match[1]),
      ),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * Files that read a row's `.locale` without resolving it, because they only
   * carry the raw column to a consumer that does. Each entry names the
   * consumer; adding one here is a review decision, not a default.
   */
  const PROJECTION_ONLY = [
    // Projects `User.locale` into the cron candidate row; the status crons
    // and the forced-warm path in `reminder/insights-handlers.ts` resolve it.
    "lib/jobs/status-cron-candidates.ts",
  ];

  it("T3 — every job file that reads a row's locale imports resolveJobLocale", () => {
    const readers = files.filter(
      (rel) => rowLocaleReceivers(read(rel)).length > 0,
    );
    // The sweep is only meaningful if it actually finds the row readers.
    expect(readers.length).toBeGreaterThan(5);
    const offenders = readers
      .filter((rel) => !PROJECTION_ONLY.includes(rel))
      .filter((rel) => !/from "@\/lib\/i18n\/job-locale"/.test(read(rel)));
    expect(offenders).toEqual([]);
    // The allowlist must not outlive its entries.
    for (const rel of PROJECTION_ONLY) {
      expect(readers).toContain(rel);
    }
  });
});
