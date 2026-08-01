/**
 * What the "what counts toward your score" surface shows, and what it
 * refuses to show.
 *
 * Three decisions are pinned here because each of them is a sentence a
 * person reads about their own health, and each has a plausible wrong
 * version that would look fine in a screenshot:
 *
 *   1. A pillar every feeding module has switched off gets NO row. Not a
 *      greyed row, not a "waiting for data" line. It is not waiting for
 *      anything, and under a never-written recipe the word "selected"
 *      would describe a default nobody picked.
 *   2. "Selected, waiting for data" belongs to a pillar the person
 *      counts, whose module is on, and which the SERVER said has nothing
 *      to score. Not to a pillar the person just switched off, and not to
 *      one the server never mentioned.
 *   3. Wellbeing under crisis signposting is its own state and never a
 *      configuration problem.
 */
import { describe, expect, it } from "vitest";

import {
  buildScoreConfigRows,
  showsWaitingForData,
  type ScoreConfigRow,
} from "@/lib/score-config/rows";
import {
  SCORE_PILLAR_IDS,
  type ScorePillarId,
} from "@/lib/analytics/score/types";

const ALL: ScorePillarId[] = [...SCORE_PILLAR_IDS];
const ALL_MODULES_ON = {
  glucose: true,
  labs: true,
  sleep: true,
  mentalHealth: true,
};

function rowsOf(result: ReturnType<typeof buildScoreConfigRows>) {
  return result.groups.flatMap((group) => group.rows);
}

function row(
  result: ReturnType<typeof buildScoreConfigRows>,
  id: ScorePillarId,
): ScoreConfigRow | undefined {
  return rowsOf(result).find((candidate) => candidate.id === id);
}

describe("grouping", () => {
  it("puts blood pressure, glycaemia and lipids under one domain", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: ALL_MODULES_ON,
    });

    const cardio = built.groups.find(
      (group) => group.domain === "cardiometabolic",
    );
    expect(cardio).toBeDefined();
    expect(cardio?.rows.map((r) => r.id)).toEqual([
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "LIPIDS",
    ]);
  });

  it("gives every other pillar a domain of its own", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: ALL_MODULES_ON,
    });

    for (const group of built.groups) {
      if (group.domain === "cardiometabolic") continue;
      expect(group.rows).toHaveLength(1);
    }
    // Five domains across seven pillars is the whole reason the surface
    // groups: equal weight per pillar is not equal weight per domain.
    expect(built.groups).toHaveLength(5);
    expect(rowsOf(built)).toHaveLength(SCORE_PILLAR_IDS.length);
  });

  it("emits no group for a domain whose only pillar is hidden", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: { ...ALL_MODULES_ON, sleep: false },
    });

    expect(built.groups.some((group) => group.domain === "sleep")).toBe(false);
  });
});

describe("a module that is off", () => {
  it("removes the pillar entirely rather than showing it as waiting", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: { ...ALL_MODULES_ON, sleep: false },
      verdicts: { SLEEP: { status: "insufficient", reason: "stale" } },
    });

    expect(row(built, "SLEEP")).toBeUndefined();
    expect(built.omitted).toContain("SLEEP");
  });

  it("keeps glycaemia while either of its two modules is on", () => {
    const glucoseOnly = buildScoreConfigRows({
      selection: ALL,
      modules: { ...ALL_MODULES_ON, labs: false },
    });
    const labsOnly = buildScoreConfigRows({
      selection: ALL,
      modules: { ...ALL_MODULES_ON, glucose: false },
    });

    expect(row(glucoseOnly, "GLYCAEMIA")).toBeDefined();
    expect(row(labsOnly, "GLYCAEMIA")).toBeDefined();
    // Lipids ride on labs alone, so they leave with it.
    expect(row(glucoseOnly, "LIPIDS")).toBeUndefined();
    expect(row(labsOnly, "LIPIDS")).toBeDefined();
  });

  it("hides glycaemia only when both of its modules are off", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: { ...ALL_MODULES_ON, glucose: false, labs: false },
    });

    expect(row(built, "GLYCAEMIA")).toBeUndefined();
    expect(built.omitted).toEqual(["GLYCAEMIA", "LIPIDS"]);
  });

  it("reads a missing module key as on", () => {
    const built = buildScoreConfigRows({ selection: ALL, modules: {} });

    expect(rowsOf(built)).toHaveLength(SCORE_PILLAR_IDS.length);
    expect(built.omitted).toEqual([]);
  });

  it("never omits a pillar no module feeds", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: {
        glucose: false,
        labs: false,
        sleep: false,
        mentalHealth: false,
      },
    });

    for (const id of [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "ADIPOSITY",
    ] as ScorePillarId[]) {
      expect(row(built, id)).toBeDefined();
    }
  });
});

describe("selected, waiting for data", () => {
  it("is shown for a counted pillar the server had nothing to score", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: ALL_MODULES_ON,
      verdicts: { LIPIDS: { status: "insufficient", reason: "not_tracked" } },
    });

    const lipids = row(built, "LIPIDS");
    expect(lipids?.eligibility).toBe("waiting");
    expect(showsWaitingForData(lipids!)).toBe(true);
  });

  it("is not shown for a pillar the draft has switched off", () => {
    const built = buildScoreConfigRows({
      selection: ALL.filter((id) => id !== "LIPIDS"),
      modules: ALL_MODULES_ON,
      verdicts: { LIPIDS: { status: "insufficient", reason: "not_tracked" } },
    });

    const lipids = row(built, "LIPIDS");
    expect(lipids?.counts).toBe(false);
    expect(showsWaitingForData(lipids!)).toBe(false);
  });

  it("is not shown while the server has said nothing", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: ALL_MODULES_ON,
    });

    const lipids = row(built, "LIPIDS");
    expect(lipids?.eligibility).toBe("unknown");
    expect(showsWaitingForData(lipids!)).toBe(false);
  });

  it("is not shown for a pillar that scored", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: ALL_MODULES_ON,
      verdicts: { SLEEP: { status: "ok" } },
    });

    const sleep = row(built, "SLEEP");
    expect(sleep?.eligibility).toBe("counting");
    expect(showsWaitingForData(sleep!)).toBe(false);
  });
});

describe("states that are not absence", () => {
  it("keeps crisis signposting out of the waiting state", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: ALL_MODULES_ON,
      verdicts: {
        WELLBEING: {
          status: "insufficient",
          reason: "crisis_signposting",
        },
      },
    });

    const wellbeing = row(built, "WELLBEING");
    expect(wellbeing?.eligibility).toBe("crisis");
    expect(showsWaitingForData(wellbeing!)).toBe(false);
  });

  it("keeps a failed read out of the waiting state", () => {
    const built = buildScoreConfigRows({
      selection: ALL,
      modules: ALL_MODULES_ON,
      verdicts: {
        BLOOD_PRESSURE: { status: "insufficient", reason: "read_failed" },
      },
    });

    const bp = row(built, "BLOOD_PRESSURE");
    expect(bp?.eligibility).toBe("read_failed");
    expect(showsWaitingForData(bp!)).toBe(false);
  });
});
