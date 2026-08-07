/**
 * The rule that decides whether a logged bleeding day starts a cycle.
 *
 * It is the one piece of the flow-to-cycle inference that is a judgement
 * rather than bookkeeping, and a wrong yes is worse than a wrong no: a false
 * cycle start corrupts every length the engine derives after it, while a
 * missed one leaves the person exactly where they were before, with the
 * one-tap start still available on any date.
 */
import { describe, it, expect } from "vitest";

import { bleedOpensCycle } from "../cycle-boundaries";
import { HARD_CYCLE_MIN } from "../types";
import { addDays } from "../day-math";

const DAY = "2026-06-01";

describe("bleedOpensCycle", () => {
  it("opens the first cycle a record ever has", () => {
    expect(bleedOpensCycle("MEDIUM", false, null, DAY)).toBe(true);
    expect(bleedOpensCycle("HEAVY", false, null, DAY)).toBe(true);
    expect(bleedOpensCycle("LIGHT", false, null, DAY)).toBe(true);
  });

  it("declines a day that records no bleeding", () => {
    expect(bleedOpensCycle(null, false, null, DAY)).toBe(false);
    expect(bleedOpensCycle("NONE", false, null, DAY)).toBe(false);
  });

  it("declines spotting", () => {
    // As often the tail or the herald of a period as its first day, and the
    // person has a chip for a real flow when it is one.
    expect(bleedOpensCycle("SPOTTING", false, null, DAY)).toBe(false);
  });

  it("declines bleeding the person flagged as between periods", () => {
    expect(bleedOpensCycle("HEAVY", true, null, DAY)).toBe(false);
  });

  it("declines a bleeding day inside the current cycle's plausible span", () => {
    // Day two, day three, and a day somebody forgot and entered late: all of
    // them are this period, not a new one.
    for (const offset of [1, 2, 4, HARD_CYCLE_MIN - 1]) {
      expect(bleedOpensCycle("HEAVY", false, addDays(DAY, -offset), DAY)).toBe(
        false,
      );
    }
  });

  it("declines a bleeding day on a date a cycle already starts", () => {
    // What the one-tap boundary's own day-log write hits.
    expect(bleedOpensCycle("MEDIUM", false, DAY, DAY)).toBe(false);
  });

  it("opens the next cycle at the hard physiological minimum and beyond", () => {
    expect(
      bleedOpensCycle("MEDIUM", false, addDays(DAY, -HARD_CYCLE_MIN), DAY),
    ).toBe(true);
    expect(bleedOpensCycle("MEDIUM", false, addDays(DAY, -28), DAY)).toBe(true);
  });

  it("declines when the nearest cycle start is AFTER the day", () => {
    // Never happens through the resolver (it queries `startDate <= date`), but
    // a negative gap must not read as a large one.
    expect(bleedOpensCycle("HEAVY", false, addDays(DAY, 10), DAY)).toBe(false);
  });
});
