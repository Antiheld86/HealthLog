import { describe, it, expect } from "vitest";

import {
  PROFILE_HOURS,
  foldHourlyCumulative,
} from "../intraday-cumulative-profile";
import type { PerSampleRow } from "../consolidation-tz";

/**
 * The pure fold is the whole substrate: everything the same-time baseline
 * compares is a slice of what this function produced, months earlier, in the
 * transaction that deleted the rows it read. If the fold is wrong nothing
 * downstream can notice, because the evidence is gone.
 */

const TZ = "Europe/Berlin";

function row(
  iso: string,
  value: number,
  externalId: string | null = null,
): PerSampleRow {
  return {
    id: `row-${iso}-${value}`,
    type: "ACTIVITY_STEPS",
    value,
    measuredAt: new Date(iso),
    externalId,
  };
}

describe("foldHourlyCumulative", () => {
  it("accumulates into the local hour each sample fell in", () => {
    // 07:30 and 07:50 Berlin (= 05:30 / 05:50 UTC in June) land in hour 7;
    // 21:10 Berlin lands in hour 21.
    const fold = foldHourlyCumulative(
      [
        row("2026-06-10T05:30:00Z", 400),
        row("2026-06-10T05:50:00Z", 600),
        row("2026-06-10T19:10:00Z", 1000),
      ],
      "2026-06-10",
      TZ,
    );

    expect(fold).not.toBeNull();
    expect(fold!.hourlyCumulative).toHaveLength(PROFILE_HOURS);
    expect(fold!.hourlyCumulative[6]).toBe(0);
    expect(fold!.hourlyCumulative[7]).toBe(1000);
    expect(fold!.hourlyCumulative[20]).toBe(1000);
    expect(fold!.hourlyCumulative[21]).toBe(2000);
    expect(fold!.hourlyCumulative[23]).toBe(2000);
    expect(fold!.dayTotal).toBe(2000);
    expect(fold!.sampleCount).toBe(3);
  });

  it("never decreases", () => {
    const fold = foldHourlyCumulative(
      [
        row("2026-06-10T06:00:00Z", 120),
        row("2026-06-10T10:00:00Z", 80),
        row("2026-06-10T16:00:00Z", 300),
      ],
      "2026-06-10",
      TZ,
    );
    const curve = fold!.hourlyCumulative;
    for (let h = 1; h < curve.length; h += 1) {
      expect(curve[h]).toBeGreaterThanOrEqual(curve[h - 1]);
    }
  });

  it("skips an already-collapsed daily total", () => {
    // The trap this guards: a `stats:` day-sum row would dump the whole day
    // into whichever hour it happens to sit in and invent a shape that never
    // happened. Only the per-sample row may contribute.
    const fold = foldHourlyCumulative(
      [
        row(
          "2026-06-10T10:00:00Z",
          12_000,
          "stats:HKQuantityTypeIdentifierStepCount:2026-06-10",
        ),
        row("2026-06-10T06:00:00Z", 500),
      ],
      "2026-06-10",
      TZ,
    );
    expect(fold!.dayTotal).toBe(500);
    expect(fold!.sampleCount).toBe(1);
  });

  it("skips rows from another local day", () => {
    // 23:30 UTC on the 9th is already the 10th in Berlin, and 22:30 UTC on the
    // 10th is already the 11th — a caller may hand over a padded window.
    const fold = foldHourlyCumulative(
      [
        row("2026-06-09T21:00:00Z", 999),
        row("2026-06-10T06:00:00Z", 500),
        row("2026-06-10T22:30:00Z", 777),
      ],
      "2026-06-10",
      TZ,
    );
    expect(fold!.dayTotal).toBe(500);
    expect(fold!.sampleCount).toBe(1);
  });

  it("returns null for a day with no usable sample", () => {
    // Absence is absence. A zero-filled profile would claim the person walked
    // nothing all day, which is a different statement from "nobody measured".
    expect(foldHourlyCumulative([], "2026-06-10", TZ)).toBeNull();
    expect(
      foldHourlyCumulative(
        [row("2026-06-10T10:00:00Z", 9000, "stats:X:2026-06-10")],
        "2026-06-10",
        TZ,
      ),
    ).toBeNull();
  });

  it("keeps a measured day of genuine zeros as a real profile", () => {
    const fold = foldHourlyCumulative(
      [row("2026-06-10T06:00:00Z", 0), row("2026-06-10T14:00:00Z", 0)],
      "2026-06-10",
      TZ,
    );
    expect(fold).not.toBeNull();
    expect(fold!.dayTotal).toBe(0);
    expect(fold!.sampleCount).toBe(2);
  });

  it("still produces 24 slots across a DST transition", () => {
    // 2026-03-29 is the spring-forward day in Berlin: 02:00 local never
    // happens. The profile must still be 24 slots so every stored day stays
    // index-comparable with every other.
    const fold = foldHourlyCumulative(
      [row("2026-03-29T00:30:00Z", 100), row("2026-03-29T09:00:00Z", 400)],
      "2026-03-29",
      "Europe/Berlin",
    );
    expect(fold!.hourlyCumulative).toHaveLength(PROFILE_HOURS);
    expect(fold!.dayTotal).toBe(500);
  });

  it("folds a fall-back day's repeated hour into one slot", () => {
    // 2026-10-25 in Berlin runs 02:00–02:59 twice (00:30 and 01:30 UTC).
    const fold = foldHourlyCumulative(
      [row("2026-10-25T00:30:00Z", 10), row("2026-10-25T01:30:00Z", 20)],
      "2026-10-25",
      "Europe/Berlin",
    );
    expect(fold!.hourlyCumulative).toHaveLength(PROFILE_HOURS);
    expect(fold!.hourlyCumulative[2]).toBe(30);
    expect(fold!.dayTotal).toBe(30);
    expect(fold!.sampleCount).toBe(2);
  });

  it("adds element-wise to the same curve a single fold would produce", () => {
    // The property the additive merge in the drain relies on: a cumulative sum
    // is linear, so folding two halves and adding equals folding the union.
    const first = [row("2026-06-10T06:00:00Z", 500)];
    const second = [row("2026-06-10T16:00:00Z", 700)];

    const a = foldHourlyCumulative(first, "2026-06-10", TZ)!;
    const b = foldHourlyCumulative(second, "2026-06-10", TZ)!;
    const union = foldHourlyCumulative(
      [...first, ...second],
      "2026-06-10",
      TZ,
    )!;

    const merged = a.hourlyCumulative.map((v, h) => v + b.hourlyCumulative[h]);
    expect(merged).toEqual(union.hourlyCumulative);
    expect(a.sampleCount + b.sampleCount).toBe(union.sampleCount);
  });
});
