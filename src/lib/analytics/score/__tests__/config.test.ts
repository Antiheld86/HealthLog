/**
 * v1.35.0 — the per-user Health Score composition resolver.
 *
 * The failure this file exists to catch is silent by nature: a resolver
 * that folds "never chose" into "chose nothing", or that quietly widens
 * an authored recipe, changes people's numbers without anyone seeing a
 * stack trace. Every assertion below is about a distinction staying a
 * distinction.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEALTH_SCORE_CONFIG,
  healthScoreConfigFromSelection,
  resolveHealthScoreConfig,
} from "../config";
import { SCORE_PILLAR_IDS, type ScorePillarId } from "../types";

const ALL: ScorePillarId[] = [...SCORE_PILLAR_IDS];

describe("resolveHealthScoreConfig — never chose", () => {
  it("treats a NULL row as counting every pillar, with no selection", () => {
    const resolved = resolveHealthScoreConfig(null);
    expect(resolved.pillars).toEqual(ALL);
    expect(resolved.excludedPillars).toEqual([]);
    expect(resolved.hasSelection).toBe(false);
    expect(resolved.version).toBe(0);
    expect(resolved.changedAt).toBeNull();
  });

  it("treats an empty object and a blob without the key the same way", () => {
    for (const raw of [{}, { version: 4, changedAt: "2026-07-31" }]) {
      const resolved = resolveHealthScoreConfig(raw);
      expect(resolved.hasSelection).toBe(false);
      expect(resolved.pillars).toEqual(ALL);
      expect(resolved.version).toBe(0);
    }
  });

  it("falls back to counting everything when the blob no longer parses", () => {
    for (const raw of [
      { excludedPillars: "SLEEP" },
      { excludedPillars: [17] },
      "not an object",
      42,
    ]) {
      const resolved = resolveHealthScoreConfig(raw);
      expect(resolved.pillars).toEqual(ALL);
      expect(resolved.hasSelection).toBe(false);
    }
  });

  it("hands back a copy, so a caller cannot mutate the shared defaults", () => {
    const resolved = resolveHealthScoreConfig(null);
    resolved.pillars.pop();
    expect(DEFAULT_HEALTH_SCORE_CONFIG.pillars).toEqual(ALL);
    expect(resolveHealthScoreConfig(null).pillars).toEqual(ALL);
  });
});

describe("resolveHealthScoreConfig — never chose is not chose nothing", () => {
  it("keeps an empty selection empty instead of reading it as no choice", () => {
    const choseNothing = resolveHealthScoreConfig({
      excludedPillars: ALL,
      version: 2,
      changedAt: "2026-07-31T09:00:00.000Z",
    });
    expect(choseNothing.pillars).toEqual([]);
    expect(choseNothing.hasSelection).toBe(true);
    expect(choseNothing.version).toBe(2);

    const neverChose = resolveHealthScoreConfig(null);
    expect(neverChose.pillars).not.toEqual(choseNothing.pillars);
    expect(neverChose.hasSelection).not.toBe(choseNothing.hasSelection);
  });

  it("counts a kept-everything selection as an authored choice", () => {
    const kept = resolveHealthScoreConfig({
      excludedPillars: [],
      version: 1,
      changedAt: "2026-07-31T09:00:00.000Z",
    });
    // Same composition as an account that never chose, different state:
    // this person opened the surface and kept every pillar.
    expect(kept.pillars).toEqual(ALL);
    expect(kept.hasSelection).toBe(true);
    expect(kept.version).toBe(1);
    expect(resolveHealthScoreConfig(null).hasSelection).toBe(false);
  });
});

describe("resolveHealthScoreConfig — the catalogue wins", () => {
  it("drops ids the build does not know", () => {
    const resolved = resolveHealthScoreConfig({
      excludedPillars: ["SLEEP", "MOON_PHASE", "LIPIDS"],
      version: 1,
    });
    expect(resolved.excludedPillars).toEqual(["SLEEP", "LIPIDS"]);
    expect(resolved.pillars).not.toContain("SLEEP");
    expect(resolved.pillars).not.toContain("LIPIDS");
    expect(resolved.pillars).toContain("BLOOD_PRESSURE");
  });

  it("de-duplicates and restores registry order", () => {
    const resolved = resolveHealthScoreConfig({
      excludedPillars: ["LIPIDS", "SLEEP", "LIPIDS"],
      version: 1,
    });
    expect(resolved.excludedPillars).toEqual(["SLEEP", "LIPIDS"]);
    expect(resolved.pillars).toEqual(
      ALL.filter((id) => id !== "SLEEP" && id !== "LIPIDS"),
    );
  });

  it("partitions the catalogue exactly: counted plus excluded is everything", () => {
    const resolved = resolveHealthScoreConfig({
      excludedPillars: ["WELLBEING"],
      version: 1,
    });
    expect([...resolved.pillars, ...resolved.excludedPillars].sort()).toEqual(
      [...ALL].sort(),
    );
  });
});

/**
 * The reconciliation the deselection list buys: a pillar that did not
 * exist when the person chose is absent from their stored list, so it
 * counts. The blob below is one written in a smaller world, naming only
 * ids that existed then. Every later pillar must arrive counted, and no
 * choice the person actually made may be undone in the process.
 */
describe("resolveHealthScoreConfig — a pillar shipped later", () => {
  const STORED_IN_A_SMALLER_WORLD = {
    excludedPillars: ["SLEEP"],
    version: 3,
    changedAt: "2026-01-04T08:00:00.000Z",
  };

  it("counts every pillar the person never had the chance to remove", () => {
    const resolved = resolveHealthScoreConfig(STORED_IN_A_SMALLER_WORLD);
    for (const id of ALL) {
      if (id === "SLEEP") continue;
      expect(resolved.pillars).toContain(id);
    }
  });

  it("still honours the one removal the person did make", () => {
    const resolved = resolveHealthScoreConfig(STORED_IN_A_SMALLER_WORLD);
    expect(resolved.pillars).not.toContain("SLEEP");
    expect(resolved.excludedPillars).toEqual(["SLEEP"]);
    expect(resolved.version).toBe(3);
    expect(resolved.changedAt).toBe("2026-01-04T08:00:00.000Z");
  });
});

describe("healthScoreConfigFromSelection", () => {
  it("stores the complement of the selection and round-trips it", () => {
    const selection: ScorePillarId[] = [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
    ];
    const blob = healthScoreConfigFromSelection({
      selection,
      version: 5,
      changedAt: new Date("2026-07-31T10:15:00.000Z"),
    });
    expect(blob.excludedPillars).toEqual(
      ALL.filter((id) => !selection.includes(id)),
    );
    expect(blob.version).toBe(5);
    expect(blob.changedAt).toBe("2026-07-31T10:15:00.000Z");

    const resolved = resolveHealthScoreConfig(blob);
    expect(resolved.pillars).toEqual(selection);
    expect(resolved.hasSelection).toBe(true);
    expect(resolved.version).toBe(5);
  });

  it("stores every pillar as excluded when the selection is empty", () => {
    const blob = healthScoreConfigFromSelection({
      selection: [],
      version: 1,
      changedAt: new Date("2026-07-31T10:15:00.000Z"),
    });
    expect(blob.excludedPillars).toEqual(ALL);
    expect(resolveHealthScoreConfig(blob).pillars).toEqual([]);
  });
});
