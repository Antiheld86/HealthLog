/**
 * A booked visit's reminder appears on no preventive-care surface.
 *
 * A planned encounter mints one `MeasurementReminder` with `origin:
 * ENCOUNTER`, because an appointment is a reminder with a date and a second
 * engine would be a second cron, a second queue and a second set of
 * preferences. The cost of that decision is this: every READ that means "the
 * checkups this person keeps" now has to say so, or the checkup list fills up
 * with appointments.
 *
 * The research that proposed the feature called this "a one-line `where`". It
 * is four, and the fourth is in a different subsystem, which is exactly why it
 * is worth a guard rather than a comment.
 *
 * Two halves, deliberately:
 *
 *   1. **By source text** — each of the four read sites contains an origin
 *      exclusion. Whitespace-tolerant, and it ASSERTS A NON-ZERO MATCH COUNT.
 *      A matcher that matches nothing is green for the wrong reason; the
 *      Bearer-scope guard in this directory stayed blind for months because
 *      its regex demanded a literal a two-line call never produced, and it
 *      passed by finding nothing rather than by finding everything.
 *   2. **By behaviour** — the DTO mapper refuses an `ENCOUNTER` row. Source
 *      text cannot tell a filter that runs from one that is written, and the
 *      refusal is what turns a lost filter into a loud failure instead of an
 *      appointment relabelled as a checkup.
 *
 * What this file does NOT prove: that the four queries run. That is what the
 * mapper's throw is for, and what an integration test against real rows would
 * add. Written down so the limit is visible rather than assumed away.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";
import type { MeasurementReminder } from "@/generated/prisma/client";

const REPO_ROOT = resolve(__dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

/**
 * Every read that answers "what preventive care is due", and what each one
 * feeds. Named rather than discovered: a discovery sweep would have to guess
 * which reminder reads are Vorsorge surfaces and which are the engine itself,
 * and the engine's two reads must NOT carry the exclusion — firing the
 * appointment and satisfying it is the whole point of the row.
 */
const VORSORGE_READ_SITES: ReadonlyArray<{ file: string; surface: string }> = [
  {
    file: "src/app/api/measurement-reminders/route.ts",
    surface: "the reminder list the checkups page renders",
  },
  {
    file: "src/lib/daily/load-digest.ts",
    surface: "the daily digest's due list",
  },
  {
    file: "src/lib/insights/feature-blocks.ts",
    surface: "the insights preventive-care block",
  },
  {
    file: "src/lib/mcp/tools.ts",
    surface: "the MCP get_preventive_care tool",
  },
];

/**
 * `origin: { not: "ENCOUNTER" }`, tolerant of any formatting Prettier might
 * choose — line breaks between the key and the object, single or double
 * quotes, a trailing comma.
 */
const EXCLUSION = /origin\s*:\s*\{\s*not\s*:\s*["']ENCOUNTER["']\s*,?\s*\}/g;

function reminderRow(
  origin: MeasurementReminder["origin"],
): MeasurementReminder {
  const at = new Date("2026-07-01T09:00:00.000Z");
  return {
    id: "reminder-1",
    userId: "user-1",
    label: "Dr. Example",
    measurementType: null,
    intervalDays: null,
    rrule: null,
    anchorDate: at,
    endsOn: null,
    origin,
    notifyHour: 9,
    location: null,
    nextDueAt: at,
    lastSatisfiedAt: null,
    enabled: true,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

describe("appointment reminders are excluded from every Vorsorge read", () => {
  it("names a read set that is not empty (no vacuous pass)", () => {
    expect(VORSORGE_READ_SITES.length).toBe(4);
  });

  for (const { file, surface } of VORSORGE_READ_SITES) {
    it(`excludes ENCOUNTER rows from ${surface}`, () => {
      const source = read(file);
      const matches = source.match(EXCLUSION) ?? [];
      expect(
        matches.length,
        `${file} feeds ${surface} and no longer excludes ENCOUNTER-origin ` +
          "rows, so a booked appointment will surface there as a checkup",
      ).toBeGreaterThan(0);
    });
  }

  it("leaves the engine's own reads alone", () => {
    // The cron fires these rows and the satisfy primitive resolves them. An
    // exclusion in either would mean a booked appointment that never nudges,
    // which is the opposite failure and just as silent.
    for (const file of [
      "src/lib/jobs/measurement-reminder.ts",
      "src/lib/measurement-reminders/satisfy.ts",
    ]) {
      const matches = read(file).match(EXCLUSION) ?? [];
      expect(
        matches.length,
        `${file} is the engine, not a Vorsorge surface — excluding ENCOUNTER ` +
          "rows here would stop appointments firing at all",
      ).toBe(0);
    }
  });

  it("the Coach dedup read needs nothing, because it is already narrow", () => {
    // It filters to `origin: "COACH"`, so an ENCOUNTER row cannot reach it.
    // Asserted rather than assumed: if that narrowing ever widened, this file
    // is where the consequence should surface.
    expect(read("src/lib/ai/coach/suggest-gate.ts")).toMatch(
      /origin\s*:\s*["']COACH["']/,
    );
  });
});

describe("the reminder DTO refuses an appointment row", () => {
  it("maps a VORSORGE row normally", () => {
    expect(toMeasurementReminderDto(reminderRow("VORSORGE")).origin).toBe(
      "VORSORGE",
    );
  });

  it("maps a COACH row normally", () => {
    expect(toMeasurementReminderDto(reminderRow("COACH")).origin).toBe("COACH");
  });

  it("throws on an ENCOUNTER row rather than relabelling it", () => {
    // The invariant: every query feeding this mapper excludes them, so one
    // arriving means a read site lost its filter. Failing loudly is the only
    // honest answer — the alternative is an appointment shown as a checkup.
    expect(() => toMeasurementReminderDto(reminderRow("ENCOUNTER"))).toThrow(
      /ENCOUNTER-origin reminder/,
    );
  });

  it("names the guard file in the message, so the next reader finds the proof", () => {
    expect(() => toMeasurementReminderDto(reminderRow("ENCOUNTER"))).toThrow(
      /encounter-reminder-exclusion/,
    );
  });
});
