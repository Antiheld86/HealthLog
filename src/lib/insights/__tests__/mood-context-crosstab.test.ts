/**
 * The context × mood comparison: its floors, its correction, and the two
 * things it must never do.
 *
 * The floors are the point of this file. A board that always has something on
 * it is a board that means nothing, and the two ways to get one are to show a
 * value seen on three days and to filter a wide sweep on a raw p < 0.05. Both
 * are tested at their boundary here, because a floor nobody has watched hold
 * is a number in a constant.
 */
import { describe, expect, it } from "vitest";

import {
  CONTEXT_MIN_ABSENT_DAYS,
  CONTEXT_MIN_PRESENT_DAYS,
  computeContextMoodComparison,
  type ContextDayRow,
} from "@/lib/insights/mood-context-crosstab";

const EMPTY_CONTEXT = {
  workStatus: null,
  contactCircles: null,
  contactForm: null,
  contactExtent: null,
  leisureCategories: null,
  eventType: null,
};

function day(
  index: number,
  moodA1: number | null,
  context: Partial<ContextDayRow> = {},
): ContextDayRow {
  return {
    day: `2026-03-${String(index + 1).padStart(2, "0")}`,
    moodA1,
    ...EMPTY_CONTEXT,
    ...context,
  };
}

/** `present` days carrying `workStatus: overtime` at `lowMood`, the rest high. */
function overtimeFixture(present: number, absent: number): ContextDayRow[] {
  const rows: ContextDayRow[] = [];
  for (let i = 0; i < present; i++) {
    rows.push(day(i, i % 2 === 0 ? 2 : 3, { workStatus: "overtime" }));
  }
  for (let i = 0; i < absent; i++) {
    rows.push(day(present + i, i % 2 === 0 ? 8 : 7, { workStatus: "regular" }));
  }
  return rows;
}

describe("context × mood comparison", () => {
  it("reports the two counts and the two means it compared", () => {
    const rows = computeContextMoodComparison(overtimeFixture(10, 12));
    const overtime = rows.find((r) => r.value === "overtime");
    expect(overtime, "the overtime comparison did not survive").toBeDefined();
    expect(overtime!.field).toBe("workStatus");
    expect(overtime!.withDays).toBe(10);
    expect(overtime!.withoutDays).toBe(12);
    expect(overtime!.withAvg).toBe(2.5);
    expect(overtime!.withoutAvg).toBe(7.5);
    expect(overtime!.delta).toBe(-5);
  });

  it("holds the present-day floor at its boundary", () => {
    // One below the floor: nothing, however clean the separation looks.
    const below = computeContextMoodComparison(
      overtimeFixture(CONTEXT_MIN_PRESENT_DAYS - 1, 12),
    );
    expect(below.some((r) => r.value === "overtime")).toBe(false);

    // Exactly at it: the row is allowed to exist.
    const at = computeContextMoodComparison(
      overtimeFixture(CONTEXT_MIN_PRESENT_DAYS, 12),
    );
    expect(at.some((r) => r.value === "overtime")).toBe(true);
  });

  it("holds the absent-day floor at its boundary", () => {
    const below = computeContextMoodComparison(
      overtimeFixture(10, CONTEXT_MIN_ABSENT_DAYS - 1),
    );
    expect(below.some((r) => r.value === "overtime")).toBe(false);

    const at = computeContextMoodComparison(
      overtimeFixture(10, CONTEXT_MIN_ABSENT_DAYS),
    );
    expect(at.some((r) => r.value === "overtime")).toBe(true);
  });

  it("folds a day logged twice into one observation", () => {
    // Two entries on one day is not two days. Without the fold, somebody who
    // logs three times on their worst day drags every comparison that day
    // belongs to.
    const rows = overtimeFixture(10, 12);
    const doubled = [...rows, { ...rows[0], moodA1: 0 }];
    const once = computeContextMoodComparison(rows).find(
      (r) => r.value === "overtime",
    );
    const twice = computeContextMoodComparison(doubled).find(
      (r) => r.value === "overtime",
    );
    expect(twice!.withDays).toBe(once!.withDays);
    expect(twice!.withAvg).toBe(once!.withAvg);
  });

  it("skips days with no mood value rather than treating them as zero", () => {
    const rows = overtimeFixture(10, 12);
    rows.push(day(50, null, { workStatus: "overtime" }));
    const overtime = computeContextMoodComparison(rows).find(
      (r) => r.value === "overtime",
    );
    expect(overtime!.withDays).toBe(10);
  });

  it("reads a multi-select value out of its stored JSON list", () => {
    const rows: ContextDayRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(
        day(i, i % 2 === 0 ? 3 : 4, {
          contactCircles: JSON.stringify(["partner", "family"]),
        }),
      );
    }
    for (let i = 0; i < 12; i++) {
      rows.push(
        day(10 + i, i % 2 === 0 ? 8 : 7, {
          contactCircles: JSON.stringify(["friends"]),
        }),
      );
    }
    const circles = computeContextMoodComparison(rows);
    expect(circles.find((r) => r.value === "partner")?.withDays).toBe(10);
    expect(circles.find((r) => r.value === "friends")?.withDays).toBe(12);
  });

  it("drops noise a raw p < 0.05 would have surfaced", () => {
    // Twenty-odd values tested against a mood series with no structure in it.
    // Some pair will look significant at 0.05 sooner or later; the point of
    // the family-wide correction is that it does not reach the board.
    const values = [
      ...Array.from({ length: 40 }, (_, i) =>
        day(i, (i * 7) % 11, {
          contactCircles: JSON.stringify([
            ["partner", "child", "family", "friends"][i % 4],
          ]),
          leisureCategories: JSON.stringify([
            ["film", "reading", "gaming", "music"][i % 4],
          ]),
          eventType: ["goodNews", "badNews", "success", "conflict"][i % 4],
        }),
      ),
    ];
    const rows = computeContextMoodComparison(values);
    for (const row of rows) {
      expect(row.qValue).toBeLessThanOrEqual(0.1);
    }
  });

  it("answers nothing at all on an empty history", () => {
    expect(computeContextMoodComparison([])).toEqual([]);
    expect(computeContextMoodComparison([day(0, null)])).toEqual([]);
  });
});
