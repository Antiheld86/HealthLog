/**
 * Structural guard: background and insight readers must not materialise a
 * dense measurement stream.
 *
 * #1023: a single account syncing heart rate from a watch took the worker
 * down within half an hour. The status-card read was bounded in time
 * (`measuredAt >= now − 91 days`) but not in rows, and a stream sampled every
 * minute or faster turns 91 days into six or seven figures of objects. The
 * read also ran into the statement timeout. The cure was to fold per day in
 * SQL (`readDayAggregates`, `readLiveBuckets`), so the reader's size tracks
 * the number of days, not the sampling rate.
 *
 * What this guard pins, in the directories that run on the worker or feed an
 * insight: every `measurement.findMany` without a `take` reads a type that is
 * named as a literal and is not one a device streams. A read whose type is a
 * variable could be handed a dense type by the next caller, so it must be
 * listed below with the reason it is safe. The list is frozen both ways: a new
 * unlisted read fails, and an entry whose read is gone fails too.
 *
 * It is a tripwire, not a proof: the matcher reads source text, and a read
 * written some other way (a raw SELECT of rows, a helper in another
 * directory) passes it. The floor below fails the guard if the matcher stops
 * finding reads at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";
import {
  CUMULATIVE_HK_TYPES,
  HIGH_FREQUENCY_MEAN_TYPES,
} from "@/lib/measurements/apple-health-mapping";

const SRC = join(process.cwd(), "src");

const SCOPED_DIRS = [
  "lib/insights/",
  "lib/jobs/",
  "lib/rollups/",
  "lib/ai/",
  "lib/analytics/",
  "lib/dashboard/",
  "lib/daily/",
];

/** Types a device writes at sampling rate rather than a few times a day. */
const DENSE_TYPES: ReadonlySet<string> = new Set([
  "PULSE",
  "BLOOD_GLUCOSE",
  "HEART_RATE_VARIABILITY",
  "OXYGEN_SATURATION",
  ...CUMULATIVE_HK_TYPES,
  ...HIGH_FREQUENCY_MEAN_TYPES,
]);

/**
 * Untaken reads whose type is not a sparse literal, keyed
 * `<file>::<type expression>`, with why each stays bounded.
 */
const ALLOWED: Record<string, string> = {
  "lib/insights/comprehensive-generate.ts::(shorthand)":
    'Only reached for SLEEP_DURATION (guarded by `type === "SLEEP_DURATION"`); a few stage rows per night.',
  "lib/insights/derived/vascular-age.ts::VASCULAR_AGE_TYPE":
    "A constant for a type written at most a few times a day.",
  "lib/insights/derived/fitness-age.ts::VO2_MAX_TYPE":
    "A constant for VO2 max, written at most daily.",
  "lib/insights/derived/six-minute-walk.ts::SIX_MINUTE_WALK_TYPE":
    "A constant for six-minute-walk distance, written at most daily.",
  "lib/insights/derived/wellness-scores.ts::measurementType":
    "Daily computed / provider scores (recovery, strain, readiness), one row per day.",
  "lib/jobs/reaction-line.ts::{ in: [...types]":
    "Exact-instant match (`measuredAt: row.occurredAt`), not a window.",
  "lib/jobs/step-consolidation-repair.ts::STEP_TYPE":
    "Repair job over one user's step rows for a bounded day range; runs once per repair, not per status refresh.",
  'lib/ai/coach/snapshot.ts::"BLOOD_GLUCOSE" as never':
    "Clinical CGM metrics (time in range, GMI, CV) need individual readings; 30 days at a sensor's fixed rate (at most one a minute) stays below 45 000 rows.",
  'lib/dashboard/snapshot.ts::"BLOOD_GLUCOSE"':
    "Same 30-day clinical glucose panel as the coach snapshot, grouped by meal context.",
  "lib/ai/coach/cycle-snapshot.ts::{ in: PHASE_CROSSTAB_METRIC_TYPES":
    "Cycle-phase crosstab over 365 days. Its dense members (steps, CGM glucose) are the known remaining case; steps are drained to one row per day nightly, CGM is not. Listed so it cannot grow unseen.",
  "lib/analytics/score/reader.ts::{ in: types":
    "Health-score inputs: steps (drained to one row per day nightly), sleep, waist, weight, blood pressure, fasting glucose only.",
};

interface UntakenRead {
  file: string;
  line: number;
  typeExpr: string;
}

function scopedFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => SCOPED_DIRS.some((d) => p.startsWith(d)))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function untakenReads(): { all: number; untaken: UntakenRead[] } {
  let all = 0;
  const untaken: UntakenRead[] = [];
  for (const file of scopedFiles()) {
    const src = readFileSync(join(SRC, file), "utf8");
    // Whitespace-tolerant: a call split across lines still matches.
    const re = /\.measurement\s*\.\s*findMany\s*\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      all += 1;
      let i = m.index + m[0].length;
      let depth = 1;
      while (depth > 0 && i < src.length) {
        if (src[i] === "(") depth += 1;
        else if (src[i] === ")") depth -= 1;
        i += 1;
      }
      const call = src.slice(m.index, i);
      if (/\btake\b/.test(call)) continue;
      const typed = /\btype\s*:\s*([^,\n}]+)/.exec(call);
      const typeExpr = typed
        ? typed[1].trim()
        : /\btype\s*,/.test(call)
          ? "(shorthand)"
          : "(none)";
      untaken.push({
        file,
        line: src.slice(0, m.index).split("\n").length,
        typeExpr,
      });
    }
  }
  return { all, untaken };
}

function sparseLiteral(typeExpr: string): boolean {
  const lit = /^"([A-Z_0-9]+)"/.exec(typeExpr);
  return lit !== null && !DENSE_TYPES.has(lit[1]);
}

describe("dense measurement reads stay bounded (#1023)", () => {
  const { all, untaken } = untakenReads();

  it("finds the reads it is meant to police", () => {
    // Guard against a matcher that silently matches nothing.
    expect(all).toBeGreaterThanOrEqual(40);
    expect(untaken.length).toBeGreaterThanOrEqual(15);
  });

  it("every untaken read names a sparse literal type or is listed with its reason", () => {
    const offenders = untaken
      .filter((r) => !sparseLiteral(r.typeExpr))
      .filter((r) => !(`${r.file}::${r.typeExpr}` in ALLOWED))
      .map((r) => `${r.file}:${r.line} type ${r.typeExpr}`);
    expect(offenders).toEqual([]);
  });

  it("every listed exception still exists", () => {
    const present = new Set(untaken.map((r) => `${r.file}::${r.typeExpr}`));
    expect(Object.keys(ALLOWED).filter((k) => !present.has(k))).toEqual([]);
  });

  it("the readers fixed for #1023 fold in SQL rather than reading rows", () => {
    for (const file of [
      "lib/insights/graded-series.ts",
      "lib/rollups/tiered-context.ts",
      "lib/jobs/coach-plan-review.ts",
      "lib/measurements/daily-series-read.ts",
    ]) {
      const src = readFileSync(join(SRC, file), "utf8");
      expect(src, file).not.toMatch(/\.measurement\s*\.\s*findMany\s*\(/);
    }
    const baseline = readFileSync(
      join(SRC, "lib/insights/derived/baseline.ts"),
      "utf8",
    );
    expect(baseline).not.toMatch(/\.measurement\s*\.\s*findMany\s*\(/);
  });
});
