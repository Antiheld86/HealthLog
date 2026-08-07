/**
 * The resolved cycle verdict.
 *
 * The load-bearing case is the overdue boundary. Beyond the profile's typical
 * length plus the server's grace window the day count stops being an observed
 * fact and the verdict must say so, with the number of days. One day either
 * side of that line is the difference between a person reading "day 43" and
 * reading "15 days later than usual", so both sides are pinned here, together
 * with the day counts each side produces.
 */
import { describe, it, expect } from "vitest";

import { resolveCycleVerdict, type VerdictCalendarDay } from "../verdict";
import type { CyclePhase } from "../types";

function day(
  date: string,
  phase: CyclePhase | null,
  isFertileWindow = false,
): VerdictCalendarDay {
  return { date, phase, isFertileWindow };
}

/** A run of 5 MENSTRUAL days then LUTEAL days, `n` long, ending at `today`. */
function longRun(
  n: number,
  from = "2026-01-01",
): {
  days: VerdictCalendarDay[];
  today: string;
} {
  const start = Date.parse(`${from}T00:00:00Z`);
  const days: VerdictCalendarDay[] = [];
  for (let i = 0; i < n; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    days.push(day(date, i < 5 ? "MENSTRUAL" : "LUTEAL"));
  }
  return { days, today: days[n - 1].date };
}

describe("resolveCycleVerdict — the overdue boundary", () => {
  it("still counts on the last honest day", () => {
    // Typical 28 + a 14-day grace window = 42. Day 42 is an observed fact.
    const { days, today } = longRun(42);
    const v = resolveCycleVerdict({
      days,
      today,
      profile: { typicalCycleLength: 28 },
    });
    expect(v.state).toBe("IN_CYCLE");
    expect(v.dayOfCycle).toBe(42);
    expect(v.overdueDays).toBeNull();
  });

  it("stops counting one day later, and says how late", () => {
    const { days, today } = longRun(43);
    const v = resolveCycleVerdict({
      days,
      today,
      profile: { typicalCycleLength: 28 },
    });
    expect(v.state).toBe("OVERDUE");
    expect(v.dayOfCycle).toBeNull();
    expect(v.phase).toBeNull();
    // Measured against the typical length the person actually has, not against
    // typical + grace: 43 days into a 28-day cycle is 15 days later than usual.
    expect(v.overdueDays).toBe(15);
  });

  it("keeps growing the overdue count as the delay grows", () => {
    const { days, today } = longRun(90);
    const v = resolveCycleVerdict({
      days,
      today,
      profile: { typicalCycleLength: 28 },
    });
    expect(v.state).toBe("OVERDUE");
    expect(v.overdueDays).toBe(62);
    // The ring still draws the canonical four-phase dial rather than nothing.
    expect(v.spans).toHaveLength(4);
    expect(v.cycleLength).toBe(28);
  });

  it("moves the boundary with the profile's own typical length", () => {
    // A 60-day typical cycle keeps day 49 honest where a 28-day one would not.
    const { days, today } = longRun(49);
    const v = resolveCycleVerdict({
      days,
      today,
      profile: { typicalCycleLength: 60 },
    });
    expect(v.state).toBe("IN_CYCLE");
    expect(v.dayOfCycle).toBe(49);
    expect(v.overdueDays).toBeNull();
  });

  it("keeps the cycle start even once the count stops", () => {
    // The last logged period start is still a fact; the BBT chart scopes to it.
    const { days, today } = longRun(60);
    const v = resolveCycleVerdict({
      days,
      today,
      profile: { typicalCycleLength: 28 },
    });
    expect(v.state).toBe("OVERDUE");
    expect(v.cycleStartDate).toBe("2026-01-01");
  });
});

describe("resolveCycleVerdict — what the record supports", () => {
  it("says INSUFFICIENT_DATA when today carries no phase", () => {
    const days = [day("2026-06-01", null), day("2026-06-02", null)];
    const v = resolveCycleVerdict({ days, today: "2026-06-02" });
    expect(v.state).toBe("INSUFFICIENT_DATA");
    expect(v.dayOfCycle).toBeNull();
    expect(v.phase).toBeNull();
    expect(v.cycleStartDate).toBeNull();
    expect(v.spans).toEqual([]);
  });

  it("says INSUFFICIENT_DATA when today is absent from the grid", () => {
    const days = [day("2026-06-01", "MENSTRUAL")];
    const v = resolveCycleVerdict({ days, today: "2026-06-09" });
    expect(v.state).toBe("INSUFFICIENT_DATA");
    expect(v.dayOfCycle).toBeNull();
  });

  it("counts the cycle day from the most recent menstrual start", () => {
    const days = [
      day("2026-05-30", "LUTEAL"),
      day("2026-06-01", "MENSTRUAL"),
      day("2026-06-02", "MENSTRUAL"),
      day("2026-06-03", "FOLLICULAR"),
      day("2026-06-04", "FOLLICULAR"),
      day("2026-06-05", "FOLLICULAR"),
    ];
    const v = resolveCycleVerdict({ days, today: "2026-06-05" });
    expect(v.state).toBe("IN_CYCLE");
    expect(v.dayOfCycle).toBe(5);
    expect(v.phase).toBe("FOLLICULAR");
    expect(v.cycleStartDate).toBe("2026-06-01");
  });

  it("builds observed phase arcs that sum to the whole ring", () => {
    const days = [
      day("2026-06-01", "MENSTRUAL"),
      day("2026-06-02", "MENSTRUAL"),
      day("2026-06-03", "MENSTRUAL"),
      day("2026-06-04", "FOLLICULAR"),
      day("2026-06-05", "FOLLICULAR"),
      day("2026-06-06", "OVULATORY"),
      day("2026-06-07", "LUTEAL"),
      day("2026-06-08", "LUTEAL"),
    ];
    const v = resolveCycleVerdict({ days, today: "2026-06-05" });
    expect(v.spans.reduce((s, x) => s + x.fraction, 0)).toBeCloseTo(1, 5);
    expect(v.spans.map((s) => s.phase).sort()).toEqual([
      "FOLLICULAR",
      "LUTEAL",
      "MENSTRUAL",
      "OVULATORY",
    ]);
    expect(v.cycleLength).toBe(8);
  });

  it("counts off the logged start when the grid withholds its phase labels", () => {
    // What the calendar hands over while the engine is still learning: a grid
    // with every phase suppressed. The count is not the suppressed claim.
    const days = [day("2026-06-01", null), day("2026-06-11", null)];
    const v = resolveCycleVerdict({
      days,
      today: "2026-06-11",
      profile: { typicalCycleLength: 28 },
      lastPeriodStart: "2026-06-01",
    });
    expect(v.state).toBe("IN_CYCLE");
    expect(v.dayOfCycle).toBe(11);
    expect(v.cycleStartDate).toBe("2026-06-01");
    expect(v.phase).toBeNull();
    expect(v.spans).toHaveLength(4);
  });

  it("says how late a period is with no phase labels to read", () => {
    const days = [day("2026-06-11", null)];
    const v = resolveCycleVerdict({
      days,
      today: "2026-06-11",
      profile: { typicalCycleLength: 28 },
      lastPeriodStart: "2026-04-22",
    });
    expect(v.state).toBe("OVERDUE");
    expect(v.dayOfCycle).toBeNull();
    expect(v.overdueDays).toBe(23);
    expect(v.cycleStartDate).toBe("2026-04-22");
  });

  it("counts off the logged start when today is absent from the grid", () => {
    const days = [day("2026-06-01", "MENSTRUAL")];
    const v = resolveCycleVerdict({
      days,
      today: "2026-06-09",
      lastPeriodStart: "2026-06-01",
    });
    expect(v.state).toBe("IN_CYCLE");
    expect(v.dayOfCycle).toBe(9);
  });

  it("keeps INSUFFICIENT_DATA when the anchor is ahead of today", () => {
    // A start dated in the future is not a cycle the person is in.
    const days = [day("2026-06-02", null)];
    const v = resolveCycleVerdict({
      days,
      today: "2026-06-02",
      lastPeriodStart: "2026-06-20",
    });
    expect(v.state).toBe("INSUFFICIENT_DATA");
    expect(v.cycleStartDate).toBeNull();
  });

  it("draws the canonical four arcs for a low-data tracker", () => {
    // A two-day first-ever run: the observed-share math would let MENSTRUAL
    // fill nearly the whole circle, so the ring falls back to the profile's
    // canonical proportions while the day count stays observed.
    const days = [
      day("2026-06-01", "MENSTRUAL"),
      day("2026-06-02", "MENSTRUAL"),
    ];
    const v = resolveCycleVerdict({
      days,
      today: "2026-06-02",
      profile: {
        typicalCycleLength: 28,
        typicalPeriodLength: 5,
        lutealPhaseLength: 14,
      },
    });
    expect(v.state).toBe("IN_CYCLE");
    expect(v.dayOfCycle).toBe(2);
    expect(v.spans).toHaveLength(4);
    expect(v.cycleLength).toBe(28);
    for (const span of v.spans) {
      expect(span.fraction).toBeGreaterThan(0);
      expect(span.fraction).toBeLessThan(0.95);
    }
  });
});

describe("resolveCycleVerdict — days until the next period", () => {
  const days = [
    day("2026-06-01", "MENSTRUAL"),
    day("2026-06-02", "MENSTRUAL"),
    day("2026-06-03", "FOLLICULAR"),
  ];

  it("counts forward to the predicted start", () => {
    const v = resolveCycleVerdict({
      days,
      today: "2026-06-03",
      nextPeriodStart: "2026-06-29",
    });
    expect(v.daysUntilNext).toBe(26);
  });

  it("is null when no prediction ran", () => {
    expect(
      resolveCycleVerdict({ days, today: "2026-06-03" }).daysUntilNext,
    ).toBeNull();
  });

  it("is null once the predicted start is already past", () => {
    // There is no "until" any more, and inventing a negative number would only
    // invite a client to render it.
    const v = resolveCycleVerdict({
      days,
      today: "2026-06-03",
      nextPeriodStart: "2026-06-01",
    });
    expect(v.daysUntilNext).toBeNull();
  });
});

describe("resolveCycleVerdict — the fertile window", () => {
  it("reports the window it is given and whether today falls in it", () => {
    const days = [
      day("2026-06-10", "FOLLICULAR"),
      day("2026-06-11", "OVULATORY", true),
    ];
    const v = resolveCycleVerdict({
      days,
      today: "2026-06-11",
      fertileWindowStart: "2026-06-08",
      fertileWindowEnd: "2026-06-13",
    });
    expect(v.fertileWindow).toEqual({
      start: "2026-06-08",
      end: "2026-06-13",
      active: true,
    });
  });

  it("stays empty when the caller suppressed the window", () => {
    // The route passes the ALREADY goal- and cold-start-gated values, so a
    // suppressed window arrives here as nulls and cannot reappear.
    const days = [day("2026-06-11", "OVULATORY", false)];
    const v = resolveCycleVerdict({ days, today: "2026-06-11" });
    expect(v.fertileWindow).toEqual({
      start: null,
      end: null,
      active: false,
    });
  });
});
