import { describe, expect, it } from "vitest";

import {
  getA1ForMood,
  getScoreForMood,
  moodA1Map,
} from "@/lib/validations/mood";

/**
 * The five-point label → A1 map is the single derivation point every writer
 * shares, so every anchor is asserted by value rather than by shape. A test
 * that only checked monotonicity would pass a map that had drifted a point.
 */
describe("getA1ForMood", () => {
  it("maps every five-point label onto its level-A anchor", () => {
    expect(getA1ForMood("LAUSIG")).toBe(1);
    expect(getA1ForMood("SCHLECHT")).toBe(3);
    expect(getA1ForMood("OKAY")).toBe(5);
    expect(getA1ForMood("GUT")).toBe(7);
    expect(getA1ForMood("SUPER_GUT")).toBe(9);
  });

  it("keeps the endpoints inside the scale rather than on it", () => {
    // 0 and 10 stay reachable only by a value the user set by hand: a mapped
    // historical entry must not read as more extreme than every future one.
    expect(getA1ForMood("LAUSIG")).toBeGreaterThan(0);
    expect(getA1ForMood("SUPER_GUT")).toBeLessThan(10);
  });

  it("answers the same neutral midpoint an unknown label gets from the score map", () => {
    // getScoreForMood answers 3 on a 1..5 axis for an unknown label — the
    // midpoint. A1's answer is the midpoint of its own axis, and the two are
    // asserted against each other so a change to one is loud in the other.
    expect(getScoreForMood("NOT_A_MOOD")).toBe(3);
    expect(getA1ForMood("NOT_A_MOOD")).toBe(5);
    expect(getA1ForMood("")).toBe(5);
  });

  it("is ordered and evenly spaced across the five labels", () => {
    const ordered = ["LAUSIG", "SCHLECHT", "OKAY", "GUT", "SUPER_GUT"].map(
      getA1ForMood,
    );
    expect(ordered).toEqual([1, 3, 5, 7, 9]);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i] - ordered[i - 1]).toBe(2);
    }
  });

  it("exposes exactly the five labels and nothing else", () => {
    expect(Object.keys(moodA1Map()).sort()).toEqual([
      "GUT",
      "LAUSIG",
      "OKAY",
      "SCHLECHT",
      "SUPER_GUT",
    ]);
  });

  it("agrees with the score map on ordering", () => {
    // Both axes must rank the five labels identically; a disagreement would
    // mean a row whose score and A1 tell opposite stories.
    const labels = ["LAUSIG", "SCHLECHT", "OKAY", "GUT", "SUPER_GUT"];
    const byScore = [...labels].sort(
      (a, b) => getScoreForMood(a) - getScoreForMood(b),
    );
    const byA1 = [...labels].sort((a, b) => getA1ForMood(a) - getA1ForMood(b));
    expect(byA1).toEqual(byScore);
  });
});
