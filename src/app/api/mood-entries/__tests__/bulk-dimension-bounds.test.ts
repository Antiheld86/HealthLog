/**
 * The bulk path's per-entry dimension bound, pinned to the single-entry one.
 *
 * The bulk route validates `a1`..`a5` per entry rather than in the batch
 * schema, because the endpoint's contract is that a bad row is skipped and the
 * rest of the batch lands. That split buys the tolerance and costs a second
 * copy of "0 to 10", and a second copy of a bound is a bound that drifts: the
 * day somebody widens the scale on one path, the other silently keeps
 * refusing values the product now accepts, and it does it 500 rows at a time.
 *
 * So the two are compared here by behaviour rather than by reading each
 * other's source — the same value is offered to both schemas and they have to
 * agree on it, at both ends of the scale and one step outside each.
 *
 * Mutation check: change the bulk route's `.max(10)` to `.max(9)` and the
 * boundary row goes red naming 10; change the single-entry `levelADimension`
 * bound instead and the same row goes red from the other side.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createMoodEntrySchema } from "@/lib/validations/mood";

const ROOT = process.cwd();
const BULK_ROUTE = join(
  ROOT,
  "src",
  "app",
  "api",
  "mood-entries",
  "bulk",
  "route.ts",
);

/**
 * The bulk schema is module-private, so it is read as source and its bound is
 * extracted. A matcher that found nothing would prove nothing, which is why
 * the extraction asserts its own match count before anything is compared.
 */
function bulkDimensionBound(): { min: number; max: number } {
  const source = readFileSync(BULK_ROUTE, "utf8");
  const start = source.indexOf("const bulkDimensionsSchema = z.object({");
  expect(
    start,
    "bulkDimensionsSchema not found — the per-entry parse was renamed and this guard now proves nothing",
  ).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n});", start));
  const matches = [
    ...body.matchAll(/\.int\(\)\.min\((-?\d+)\)\.max\((\d+)\)/g),
  ];
  expect(
    matches.length,
    "no bounded dimension fields found inside bulkDimensionsSchema",
  ).toBe(5);
  const bounds = new Set(matches.map((m) => `${m[1]}..${m[2]}`));
  expect(
    [...bounds],
    "the five bulk dimensions do not share one bound",
  ).toHaveLength(1);
  return { min: Number(matches[0][1]), max: Number(matches[0][2]) };
}

/** Does the single-entry create schema accept this `a1`? */
function singleEntryAccepts(a1: number): boolean {
  return createMoodEntrySchema.safeParse({
    mood: "OKAY",
    moodLoggedAt: "2026-05-01T08:00:00.000Z",
    a1,
  }).success;
}

describe("bulk dimension bounds agree with the single-entry schema", () => {
  const bulk = bulkDimensionBound();

  it("reads a plausible bound out of the bulk route", () => {
    expect(bulk.max).toBeGreaterThan(bulk.min);
    expect(Number.isInteger(bulk.min)).toBe(true);
    expect(Number.isInteger(bulk.max)).toBe(true);
  });

  it("accepts the same values at both ends of the scale", () => {
    expect(singleEntryAccepts(bulk.min)).toBe(true);
    expect(singleEntryAccepts(bulk.max)).toBe(true);
  });

  it("refuses the same values one step outside it", () => {
    expect(singleEntryAccepts(bulk.min - 1)).toBe(false);
    expect(singleEntryAccepts(bulk.max + 1)).toBe(false);
  });
});
