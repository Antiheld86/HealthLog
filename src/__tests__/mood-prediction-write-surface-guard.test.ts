/**
 * `MoodPrediction` has exactly one writer, and it is not a request.
 *
 * The product rule underneath this guard: a day carries two readings — the
 * one the person gave it and the one their own past days imply — and they are
 * never merged. The self-assessment leads and is stored exactly as it was
 * given; the prognosis is computed, carries a band and a case count, and the
 * user cannot overwrite it. A route that wrote `moodPrediction` would make the
 * second value editable, and an editable prognosis is not a prognosis: the
 * deviation between the two, which is the only thing either number is for,
 * would quietly become a number somebody could tune to zero.
 *
 * The second failure the single writer prevents is the one the cycle module
 * already paid for: a forecast written as a side effect of a page view makes
 * the output a function of browsing rather than of data
 * (`src/lib/cycle/prediction-cache.ts`, `src/lib/jobs/cycle-prediction-refresh.ts`).
 *
 * **Every matcher here asserts a non-zero match count.** Legs (a) and (b)
 * expect an EMPTY offender set, so "found nothing" and "nothing is wrong" look
 * identical from the outside — which is precisely how the bearer-scope guard
 * stayed green for months while matching nothing at all. Each leg therefore
 * pins a separate positive: the number of files SCANNED, and the write calls
 * the legitimate writer really does make. `describe("the matcher sees what it
 * looks for")` proves the regex against synthetic sources, including the
 * broken-across-lines form that defeated an earlier guard in this repository.
 *
 * **What this guard structurally cannot see, stated like the session-surface
 * guard states its own limit.** The matcher keys on a literal `moodPrediction`
 * delegate access. The "Delete All Data" wipe DOES delete this table — the
 * model is in `WIPE_MODELS` (`src/lib/data-wipe/wipe-plan.ts`) — but it does so
 * through a delegate resolved dynamically from the model name (`client[key]
 * .deleteMany`), so no `moodPrediction.deleteMany(` literal exists for the
 * matcher to catch, and that deletion is correctly NOT counted as a writer.
 * The wipe path's own completeness is proven elsewhere, by
 * `data-wipe-completeness.test.ts` enumerating the schema; this guard is only
 * the one about request-time writers, and it cannot be the gate on a dynamic
 * delegate. A future writer that reached the table through a computed property
 * would slip this matcher for the same reason.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/**
 * A write against the `moodPrediction` delegate, on any receiver.
 *
 * Whitespace-tolerant in every joint: Prettier breaks a long call across
 * lines, and a matcher demanding `prisma.moodPrediction.upsert(` on one line
 * is a matcher that stops matching the day the line gets long enough. The
 * receiver is left open (`prisma`, `tx`, `db`, the worker client) because
 * pinning one name would let a rename walk straight past.
 */
const WRITE_CALL =
  /\bmoodPrediction\s*\.\s*(createMany|createManyAndReturn|create|upsert|updateMany|update|deleteMany|delete)\s*\(/g;

/** The one file allowed to write, relative to `src/`. */
const SOLE_WRITER = join("lib", "jobs", "mood-prognosis-refresh.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function writeCallsIn(source: string): string[] {
  return [...source.matchAll(WRITE_CALL)].map((m) => m[1]);
}

const ALL_FILES = sourceFiles(SRC);
const PRODUCTION_FILES = ALL_FILES.filter(
  (f) => !f.includes(`${sep}__tests__${sep}`) && !f.endsWith(".test.ts"),
);

describe("MoodPrediction is written by one file", () => {
  it("scans a plausible number of source files", () => {
    // The positive control for legs (a) and (b) below, both of which pass on
    // an empty result. If this collapses, they are asserting nothing.
    expect(ALL_FILES.length).toBeGreaterThan(1000);
    expect(PRODUCTION_FILES.length).toBeGreaterThan(800);
  });

  it("(a) no route, page or component writes it", () => {
    const offenders = PRODUCTION_FILES.filter(
      (f) =>
        f.startsWith(join(SRC, "app")) || f.startsWith(join(SRC, "components")),
    ).filter((f) => writeCallsIn(readFileSync(f, "utf8")).length > 0);

    expect(
      offenders.map((f) => f.slice(SRC.length + 1)),
      "a request-time surface writes the prognosis — it is computed by the nightly job and the user cannot overwrite it",
    ).toEqual([]);
  });

  it("(b) the writer set is exactly the refresh job", () => {
    const writers = PRODUCTION_FILES.filter(
      (f) => writeCallsIn(readFileSync(f, "utf8")).length > 0,
    ).map((f) => f.slice(SRC.length + 1));

    expect(writers.sort()).toEqual([SOLE_WRITER]);
  });

  it("(c) that writer really does write — the matcher is not matching nothing", () => {
    expect(
      existsSync(join(SRC, SOLE_WRITER)),
      `${SOLE_WRITER} does not exist — the table has a guard and no writer`,
    ).toBe(true);
    const source = readFileSync(join(SRC, SOLE_WRITER), "utf8");
    const calls = writeCallsIn(source);
    expect(
      calls.length,
      "the sole writer makes no write call the matcher can see; leg (b) is then satisfied by an empty set rather than by the truth",
    ).toBeGreaterThan(0);
    // It replaces rather than accumulates: a pass writes the current window
    // and clears whatever fell out of it.
    expect(calls).toContain("deleteMany");
  });
});

describe("the matcher sees what it looks for", () => {
  it("matches a call Prettier broke across lines", () => {
    const wrapped = [
      "await prisma.moodPrediction",
      "  .upsert(",
      "    { where: { userId_date: { userId, date } } },",
      "  );",
    ].join("\n");
    expect(writeCallsIn(wrapped)).toEqual(["upsert"]);
  });

  it("matches through an aliased client", () => {
    expect(writeCallsIn("tx.moodPrediction.deleteMany({ where })")).toEqual([
      "deleteMany",
    ]);
  });

  it("does not match a read", () => {
    expect(
      writeCallsIn("const rows = await prisma.moodPrediction.findMany({})"),
    ).toEqual([]);
  });

  it("does not match a different model", () => {
    expect(writeCallsIn("prisma.moodEntry.create({ data })")).toEqual([]);
  });
});
