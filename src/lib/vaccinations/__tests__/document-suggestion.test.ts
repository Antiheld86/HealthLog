import { describe, it, expect } from "vitest";

import { ENCOUNTER_SUGGEST_WINDOW_DAYS } from "@/lib/encounters/suggest-window";
import {
  suggestVaccinationForDate,
  vaccinationSuggestWindow,
  type VaccinationSuggestionResult,
} from "../document-suggestion";

/**
 * The upload suggestion must NEVER pre-select one of two candidates. That
 * middle branch is the whole reason the rule returns a shape rather than a best
 * guess, and it is the property WR-8 breaks. Dates are relative — a fixed date
 * about "within seven days" rots the moment it slides out of the window.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/** A tx whose only used member is `vaccinationRecord.findMany`, returning `rows`. */
function fakeTx(rows: Array<{ id: string; occurredAt: Date }>) {
  return {
    vaccinationRecord: {
      findMany: async () =>
        rows.map((r) => ({
          id: r.id,
          occurredAt: r.occurredAt,
          antigenSlug: "tetanus",
          vaccineName: null,
        })),
    },
  } as never;
}

async function suggest(
  rows: Array<{ id: string; occurredAt: Date }>,
): Promise<VaccinationSuggestionResult> {
  return suggestVaccinationForDate(fakeTx(rows), {
    userId: "u1",
    anchor: daysAgo(0),
  });
}

describe("the vaccination upload suggestion", () => {
  it("shares the visit moment's window rather than forking it", () => {
    const anchor = new Date("2024-06-15T12:00:00.000Z");
    const { from, to } = vaccinationSuggestWindow(anchor);
    expect((anchor.getTime() - from.getTime()) / DAY_MS).toBe(
      ENCOUNTER_SUGGEST_WINDOW_DAYS,
    );
    expect((to.getTime() - anchor.getTime()) / DAY_MS).toBe(
      ENCOUNTER_SUGGEST_WINDOW_DAYS,
    );
  });

  it("pre-selects a single candidate", async () => {
    const result = await suggest([{ id: "v1", occurredAt: daysAgo(1) }]);
    expect(result.kind).toBe("one");
  });

  it("offers a picker with NOTHING pre-selected for two candidates (WR-8)", async () => {
    const result = await suggest([
      { id: "v1", occurredAt: daysAgo(1) },
      { id: "v2", occurredAt: daysAgo(2) },
    ]);
    // The rule returns "many", carrying no pre-selection. A verdict of "one"
    // here is the pre-select-the-first-of-two failure this assertion catches.
    expect(result.kind).toBe("many");
    if (result.kind === "many") {
      expect(result.vaccinations).toHaveLength(2);
    }
  });

  it("offers nothing when there is no candidate", async () => {
    const result = await suggest([]);
    expect(result.kind).toBe("none");
  });
});
