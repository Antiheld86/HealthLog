/**
 * Structural guard on the canonical-workout session identity.
 *
 * `pickCanonicalWorkoutRows()` collapses a HealthKit session that arrived more
 * than once under different external UUIDs. It can only do that when the row it
 * is handed carries the identity fields, and the row shape comes from each
 * caller's own Prisma `select`. Nothing in the type system connects the two:
 * `durationSec` is optional on `WorkoutPickerRow`, so a caller that omits it
 * gets silent passthrough rather than a compile error.
 *
 * That is exactly what happened. When the collapse first shipped, the key was
 * `(sportType, startedAt, endedAt, durationSec)` and only the workout list
 * selected `endedAt`. The list showed one workout while the Coach narrated the
 * duplicate, the per-sport baseline averaged it twice and the deep-link cluster
 * kept both rows. One record, four surfaces, two answers.
 *
 * These are tripwires, not proofs. They cannot show the collapse is correct —
 * that is what the unit tests do. What they can do is refuse to let a new call
 * site join the set without someone editing this file, and refuse to let the
 * identity quietly grow a field that only some callers fetch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join, sep } from "node:path";

const SRC = join(process.cwd(), "src");

/** The picker module itself — declares the identity, does not consume it. */
const PICKER = "lib/measurements/pick-canonical-workout-rows.ts";

/**
 * Every production call site of the read-time picker, frozen.
 *
 * Adding a surface that collapses workouts is a deliberate act: it must fetch
 * the identity fields or it silently disagrees with every other surface. Adding
 * the file here is the acknowledgement.
 */
const IDENTITY_OWNER: Record<string, string> = {
  "app/api/workouts/[id]/route.ts": "app/api/workouts/[id]/route.ts",
  "lib/jobs/workout-insight-generate.ts":
    "lib/jobs/workout-insight-generate.ts",
  "lib/workouts/list-read.ts": "lib/workouts/list-read.ts",
  "lib/workouts/sport-context.ts": "lib/workouts/sport-context.ts",
  // The only indirection in the set. The Coach block is handed rows it does not
  // read itself; the snapshot builder fetches them in parallel with every other
  // block's data. Recording the owner here rather than assuming the call site
  // owns its own select is the whole point of this map.
  "lib/ai/coach/snapshot-blocks/workouts-block.ts": "lib/ai/coach/snapshot.ts",
};

const EXPECTED_CALL_SITES = Object.keys(IDENTITY_OWNER).sort();

function sourceFiles(): string[] {
  return globSync("**/*.{ts,tsx}", { cwd: SRC })
    .map((p) => p.split(sep).join("/"))
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/**
 * Lines that actually invoke the picker. Comment lines are excluded because the
 * write-time sibling (`lib/workouts/canonical-rows.ts`) names the read-time
 * picker in its docblock to explain how the two layer, and that mention is
 * documentation rather than a call.
 */
function invokesPicker(source: string): boolean {
  return source
    .split("\n")
    .some(
      (line) =>
        line.includes("pickCanonicalWorkoutRows(") &&
        !/^\s*(\*|\/\/|\/\*)/.test(line),
    );
}

describe("the picker's call-site set is frozen", () => {
  it("has exactly the call sites this file acknowledges", () => {
    const found = sourceFiles()
      .filter((rel) => rel !== PICKER)
      .filter((rel) => invokesPicker(read(rel)));

    expect(found).toEqual(EXPECTED_CALL_SITES);
  });
});

describe("every call site fetches the session identity", () => {
  it.each(EXPECTED_CALL_SITES)("%s gets rows carrying durationSec", (rel) => {
    // File-level rather than per-select: a caller that fetches workout rows
    // without their duration cannot collapse a re-send, whichever select the
    // rows came from. Coarse in the safe direction — it can only fail to catch
    // a second unrelated select in the same file, never pass a caller that
    // fetches no duration at all.
    expect(read(IDENTITY_OWNER[rel])).toContain("durationSec: true");
  });
});

describe("the identity cannot quietly grow a field callers do not fetch", () => {
  it("keys the session on sportType, startedAt and durationSec only", () => {
    const picker = read(PICKER);
    const body = picker.slice(
      picker.indexOf("function exactSessionKey"),
      picker.indexOf("function rowRichness"),
    );

    expect(body).toContain("row.sportType");
    expect(body).toContain("row.startedAt");
    expect(body).toContain("row.durationSec");
    // `endedAt` is the specific field that split the callers. On a workout with
    // pauses it disagrees with `durationSec` by design, so it rejected genuine
    // re-sends while forcing every caller to fetch a fourth column.
    expect(body).not.toContain("endedAt");
  });
});
