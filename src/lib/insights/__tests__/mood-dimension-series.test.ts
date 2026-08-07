import { describe, expect, it } from "vitest";

import {
  computeMoodDimensionSeries,
  type MoodDimensionRow,
} from "@/lib/insights/mood-dimension-series";

const TODAY = "2026-08-08";

function dayKey(daysAgo: number): string {
  const d = new Date(Date.parse(`${TODAY}T00:00:00.000Z`));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function row(daysAgo: number, values: Partial<MoodDimensionRow>) {
  return {
    date: dayKey(daysAgo),
    a1: null,
    a2: null,
    a3: null,
    a4: null,
    a5: null,
    ...values,
  } as MoodDimensionRow;
}

describe("computeMoodDimensionSeries", () => {
  it("reports all five dimensions even when only one was ever answered", () => {
    const out = computeMoodDimensionSeries([row(0, { a1: 7 })], TODAY);
    expect(out.map((d) => d.key)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(out[0].present).toBe(true);
    // The other four are absent, not zero. This is the whole rule.
    for (const dimension of out.slice(1)) {
      expect(dimension.present).toBe(false);
      expect(dimension.count).toBe(0);
      expect(dimension.avg7).toBeNull();
      expect(dimension.avg30).toBeNull();
      expect(dimension.avg90).toBeNull();
      expect(dimension.latest).toBeNull();
      expect(dimension.newestDaysAgo).toBeNull();
      expect(dimension.series).toEqual([]);
    }
  });

  it("treats a dimension answered with zeros as present", () => {
    // Zero is a real answer on this scale. A presence check on truthiness
    // would report a genuinely calm week as no data at all.
    const out = computeMoodDimensionSeries(
      [row(0, { a2: 0 }), row(1, { a2: 0 })],
      TODAY,
    );
    const a2 = out.find((d) => d.key === "a2")!;
    expect(a2.present).toBe(true);
    expect(a2.count).toBe(2);
    expect(a2.avg7).toBe(0);
    expect(a2.latest).toBe(0);
  });

  it("averages several entries on the same day into one point", () => {
    const out = computeMoodDimensionSeries(
      [row(1, { a1: 4 }), row(1, { a1: 8 }), row(0, { a1: 6 })],
      TODAY,
    );
    const a1 = out[0];
    expect(a1.series).toEqual([
      { date: dayKey(1), value: 6, samples: 2 },
      { date: dayKey(0), value: 6, samples: 1 },
    ]);
    // The daily mean is the unit every other mood surface reports, so a
    // number here can be held against one there.
    expect(a1.count).toBe(3);
  });

  it("windows the means at 7, 30 and 90 days", () => {
    const out = computeMoodDimensionSeries(
      [
        row(1, { a3: 10 }), // inside all three
        row(20, { a3: 4 }), // inside 30 and 90
        row(60, { a3: 1 }), // inside 90 only
        row(200, { a3: 0 }), // outside every window
      ],
      TODAY,
    );
    const a3 = out.find((d) => d.key === "a3")!;
    expect(a3.avg7).toBe(10);
    expect(a3.avg30).toBe(7);
    expect(a3.avg90).toBe(5);
    // The out-of-window row contributes to nothing, not even the count.
    expect(a3.count).toBe(3);
    expect(a3.series).toHaveLength(3);
  });

  it("carries the newest value with its age, per dimension", () => {
    // The point of a per-dimension age: stress can be a week stale while
    // pleasantness was answered this morning.
    const out = computeMoodDimensionSeries(
      [row(0, { a1: 8 }), row(6, { a2: 9 })],
      TODAY,
    );
    const a1 = out.find((d) => d.key === "a1")!;
    const a2 = out.find((d) => d.key === "a2")!;
    expect(a1.latest).toBe(8);
    expect(a1.latestDate).toBe(dayKey(0));
    expect(a1.newestDaysAgo).toBe(0);
    expect(a2.latest).toBe(9);
    expect(a2.newestDaysAgo).toBe(6);
  });

  it("carries the orientation rather than flipping the stored value", () => {
    const out = computeMoodDimensionSeries([row(0, { a2: 9 })], TODAY);
    const a2 = out.find((d) => d.key === "a2")!;
    expect(a2.inverse).toBe(true);
    // Stored literally: a 9 the user set is a 9 here. Flipping on the way
    // through would make the chart disagree with the label they answered.
    expect(a2.latest).toBe(9);
    expect(out.filter((d) => d.inverse).map((d) => d.key)).toEqual(["a2"]);
  });

  it("ignores a malformed day key and a future-dated row", () => {
    const out = computeMoodDimensionSeries(
      [
        { date: "not-a-date", a1: 9, a2: null, a3: null, a4: null, a5: null },
        row(-3, { a1: 1 }),
        row(2, { a1: 5 }),
      ],
      TODAY,
    );
    const a1 = out[0];
    expect(a1.count).toBe(1);
    expect(a1.latest).toBe(5);
  });

  it("answers five empty summaries for no rows at all", () => {
    const out = computeMoodDimensionSeries([], TODAY);
    expect(out).toHaveLength(5);
    expect(out.every((d) => !d.present)).toBe(true);
  });
});
