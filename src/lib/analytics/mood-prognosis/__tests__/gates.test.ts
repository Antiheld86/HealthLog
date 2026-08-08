/**
 * The minimum-n ladder, at every boundary, from both sides.
 *
 * Each case names the threshold it is about, so a red here says which floor
 * moved rather than "expected false to be true". That matters more than usual:
 * the thing these gates prevent is invisible on screen, so the test output is
 * the only place the failure is ever legible.
 *
 * Every one of these has been watched failing — the comparison flipped from
 * `>=` to `>`, the red read, the file restored and the hash checked — and one
 * check was deleted outright to prove the absence of a gate fails too. The log
 * is in the phase's execution notes.
 *
 * The assertions name the REASON, not just the absence: "no forecast" and "no
 * forecast because there are only eleven entries and fifteen is where anything
 * starts" are different answers, and only the second one can be shown to
 * somebody.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MIN_ENTRIES_FOR_FORECAST,
  MIN_ENTRIES_FOR_REGULAR_FORECAST,
  MIN_ENTRIES_FOR_SEASONAL,
  MIN_ENTRIES_LEARNING_PHASE,
  MIN_TAG_OCCURRENCES,
  forecastGate,
  occurrencesSuffice,
  prognosisStage,
  seasonalComparisonsUnlocked,
} from "../thresholds";
import { CONTEXT_MIN_PRESENT_DAYS } from "@/lib/insights/mood-context-crosstab";

describe("the ladder is ordered and its rungs are the documented numbers", () => {
  it("holds the values the concept asks for", () => {
    expect(MIN_ENTRIES_LEARNING_PHASE).toBe(15);
    expect(MIN_ENTRIES_FOR_FORECAST).toBe(30);
    expect(MIN_ENTRIES_FOR_REGULAR_FORECAST).toBe(60);
    expect(MIN_ENTRIES_FOR_SEASONAL).toBe(90);
  });

  it("rises strictly, so no rung can be reached before the one below it", () => {
    expect(MIN_ENTRIES_LEARNING_PHASE).toBeLessThan(MIN_ENTRIES_FOR_FORECAST);
    expect(MIN_ENTRIES_FOR_FORECAST).toBeLessThan(
      MIN_ENTRIES_FOR_REGULAR_FORECAST,
    );
    expect(MIN_ENTRIES_FOR_REGULAR_FORECAST).toBeLessThan(
      MIN_ENTRIES_FOR_SEASONAL,
    );
  });
});

describe("MIN_ENTRIES_LEARNING_PHASE — below it, nothing at all", () => {
  it(`refuses at ${MIN_ENTRIES_LEARNING_PHASE - 1}, and says why`, () => {
    const gate = forecastGate(MIN_ENTRIES_LEARNING_PHASE - 1);
    expect(gate.present, "MIN_ENTRIES_LEARNING_PHASE let n-1 through").toBe(
      false,
    );
    expect(gate).toEqual({
      present: false,
      reason: "no-output-yet",
      stage: "insufficient",
      entries: MIN_ENTRIES_LEARNING_PHASE - 1,
      nextThreshold: MIN_ENTRIES_LEARNING_PHASE,
    });
  });

  it(`reaches the learning phase at exactly ${MIN_ENTRIES_LEARNING_PHASE}`, () => {
    const gate = forecastGate(MIN_ENTRIES_LEARNING_PHASE);
    expect(
      gate,
      "MIN_ENTRIES_LEARNING_PHASE did not admit its own value",
    ).toEqual({
      present: false,
      reason: "learning-phase",
      stage: "learning",
      entries: MIN_ENTRIES_LEARNING_PHASE,
      nextThreshold: MIN_ENTRIES_FOR_FORECAST,
    });
  });

  it("an empty account is absence, never a zero", () => {
    const gate = forecastGate(0);
    expect(gate.present).toBe(false);
    expect(gate).not.toHaveProperty("predicted");
    if (!gate.present) expect(gate.entries).toBe(0);
  });
});

describe("MIN_ENTRIES_FOR_FORECAST — below it, no forecast", () => {
  it(`refuses at ${MIN_ENTRIES_FOR_FORECAST - 1}, naming the learning phase`, () => {
    const gate = forecastGate(MIN_ENTRIES_FOR_FORECAST - 1);
    expect(gate.present, "MIN_ENTRIES_FOR_FORECAST let n-1 through").toBe(
      false,
    );
    if (!gate.present) {
      expect(gate.reason).toBe("learning-phase");
      expect(gate.nextThreshold).toBe(MIN_ENTRIES_FOR_FORECAST);
      expect(gate.entries).toBe(MIN_ENTRIES_FOR_FORECAST - 1);
    }
  });

  it(`forecasts at exactly ${MIN_ENTRIES_FOR_FORECAST}, labelled provisional`, () => {
    const gate = forecastGate(MIN_ENTRIES_FOR_FORECAST);
    expect(gate.present, "MIN_ENTRIES_FOR_FORECAST refused its own value").toBe(
      true,
    );
    if (gate.present) {
      expect(gate.stage).toBe("provisional");
      expect(gate.provisional).toBe(true);
    }
  });
});

describe("MIN_ENTRIES_FOR_REGULAR_FORECAST — below it, provisional", () => {
  it(`is still provisional at ${MIN_ENTRIES_FOR_REGULAR_FORECAST - 1}`, () => {
    const gate = forecastGate(MIN_ENTRIES_FOR_REGULAR_FORECAST - 1);
    expect(gate.present).toBe(true);
    if (gate.present) {
      expect(
        gate.provisional,
        "MIN_ENTRIES_FOR_REGULAR_FORECAST dropped the provisional label at n-1",
      ).toBe(true);
      expect(gate.stage).toBe("provisional");
    }
  });

  it(`drops the label at exactly ${MIN_ENTRIES_FOR_REGULAR_FORECAST}`, () => {
    const gate = forecastGate(MIN_ENTRIES_FOR_REGULAR_FORECAST);
    expect(gate.present).toBe(true);
    if (gate.present) {
      expect(
        gate.provisional,
        "MIN_ENTRIES_FOR_REGULAR_FORECAST kept the provisional label at its own value",
      ).toBe(false);
      expect(gate.stage).toBe("regular");
    }
  });
});

describe("MIN_ENTRIES_FOR_SEASONAL — below it, no weekday or seasonal view", () => {
  it(`refuses the comparison at ${MIN_ENTRIES_FOR_SEASONAL - 1}`, () => {
    expect(
      seasonalComparisonsUnlocked(MIN_ENTRIES_FOR_SEASONAL - 1),
      "MIN_ENTRIES_FOR_SEASONAL unlocked the comparison at n-1",
    ).toBe(false);
    expect(prognosisStage(MIN_ENTRIES_FOR_SEASONAL - 1)).toBe("regular");
  });

  it(`unlocks it at exactly ${MIN_ENTRIES_FOR_SEASONAL}`, () => {
    expect(
      seasonalComparisonsUnlocked(MIN_ENTRIES_FOR_SEASONAL),
      "MIN_ENTRIES_FOR_SEASONAL refused its own value",
    ).toBe(true);
    expect(prognosisStage(MIN_ENTRIES_FOR_SEASONAL)).toBe("seasonal");
  });
});

describe("MIN_TAG_OCCURRENCES — a value seen four times is not evidence", () => {
  it(`refuses at ${MIN_TAG_OCCURRENCES - 1}`, () => {
    expect(
      occurrencesSuffice(MIN_TAG_OCCURRENCES - 1),
      "MIN_TAG_OCCURRENCES admitted a value seen n-1 times",
    ).toBe(false);
  });

  it(`admits at exactly ${MIN_TAG_OCCURRENCES}`, () => {
    expect(
      occurrencesSuffice(MIN_TAG_OCCURRENCES),
      "MIN_TAG_OCCURRENCES refused its own value",
    ).toBe(true);
  });

  it("is the crosstab's floor rather than a second opinion about it", () => {
    expect(MIN_TAG_OCCURRENCES).toBe(CONTEXT_MIN_PRESENT_DAYS);
  });
});

describe("no second number is minted for an idea that already has one", () => {
  const THRESHOLDS = readFileSync(join(__dirname, "../thresholds.ts"), "utf8");

  it("the file really is the one under test", () => {
    // The positive control: the two checks below pass on an empty read, so
    // each needs proof the file was found and holds what it claims to.
    expect(THRESHOLDS.length).toBeGreaterThan(1000);
    expect(THRESHOLDS).toContain("MIN_ENTRIES_FOR_SEASONAL");
  });

  it("declares no paired-observation floor of its own", () => {
    // `MIN_PAIRED_N` lives in `correlations.ts` and the screening imports it
    // from there. A constant here named for the same idea would be a second
    // answer to one question, and the two would drift.
    expect(THRESHOLDS).not.toMatch(/export\s+const\s+MIN_PAIRED/);
    expect(THRESHOLDS).not.toMatch(/export\s+const\s+MIN_PAIRS/);
  });

  it("takes the occurrence floor from the crosstab rather than restating it", () => {
    expect(THRESHOLDS).toMatch(
      /MIN_TAG_OCCURRENCES\s*=\s*CONTEXT_MIN_PRESENT_DAYS/,
    );
  });
});
