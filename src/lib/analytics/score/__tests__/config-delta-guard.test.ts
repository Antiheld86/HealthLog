/**
 * The per-user recipe boundary, at the three places it exists.
 *
 * The end-to-end proof that a settings change is never narrated as a
 * health event lives in `config-change-is-not-a-health-event.test.ts`,
 * over the real snapshot and digest. This file covers what that one
 * cannot reach without a fixture per case: the boundary arithmetic's
 * edges, the notice key's two dimensions, and the seam's shape.
 *
 * Each guard here has a counter-case beside it. A boundary that
 * suppressed everything would pass every "no false drop" assertion ever
 * written and silence every honest week as well, which is the same
 * defect wearing the opposite sign.
 */
import { describe, expect, it } from "vitest";

import { buildOk, deriveCoverage } from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";
import { healthScoreNoticeItemKey } from "@/lib/daily/priority-item-key";
import { isDismissibleItemKey } from "@/lib/daily/priority-item";
import { dismissPriorityItemSchema } from "@/lib/validations/daily";

import { attachScoreDelta, crossesConfigBoundary } from "../composite";
import {
  resolveHealthScoreConfig,
  healthScoreConfigFromSelection,
  scoreConfigBoundary,
  UNCONFIGURED_SCORE_BOUNDARY,
} from "../config";
import {
  scoreCompositeSegments,
  scorePillarSeries,
  scoreSeriesSeams,
  type ScoreSeriesRecord,
} from "../series";
import type {
  CompositeValue,
  PillarValue,
  ScorePillarId,
  ScorePillarResult,
} from "../types";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-20T12:00:00.000Z");

const DOMAIN_BY_PILLAR: Record<ScorePillarId, ScorePillarResult["domain"]> = {
  BLOOD_PRESSURE: "cardiometabolic",
  GLYCAEMIA: "cardiometabolic",
  ACTIVITY: "activity",
  SLEEP: "sleep",
  ADIPOSITY: "adiposity",
  WELLBEING: "wellbeing",
  FITNESS: "fitness",
  LIPIDS: "cardiometabolic",
};

function pillar(id: ScorePillarId, score: number): ScorePillarResult {
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: 28,
    missing: [],
    fullHistoryDays: 28,
  });
  const value: PillarValue = {
    score,
    observed: {
      value: score,
      unit: "score",
      label: `${score}`,
      asOf: NOW.toISOString(),
      sources: ["MANUAL"],
    },
    reference: {
      kind: "guideline-band",
      low: 0,
      high: 100,
      label: "band",
      source: "Test 2026",
    },
    noiseFloor: 1,
    deltaEligible: true,
    deltaIdentity: id,
  };
  return {
    id,
    domain: DOMAIN_BY_PILLAR[id],
    result: buildOk({
      value,
      coverage,
      confidence,
      provenance: {
        inputs: [id],
        source: "live",
        windowDays: 28,
        computedAt: NOW.toISOString(),
      },
    }),
  };
}

/** A composite standing at `score`, computed as of `asOf`. */
function composite(score: number, asOf: Date): Derived<CompositeValue> {
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 3,
    presentInputs: 3,
    historyDays: 28,
    missing: [],
    fullHistoryDays: 28,
  });
  return buildOk<CompositeValue>({
    value: {
      score,
      band: "green",
      bandSetter: null,
      composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      noiseFloor: 1,
      scoreVersion: 2,
    },
    coverage,
    confidence,
    provenance: {
      inputs: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      source: "live",
      windowDays: 28,
      computedAt: asOf.toISOString(),
    },
  });
}

const CURRENT_PILLARS = [
  pillar("BLOOD_PRESSURE", 60),
  pillar("ACTIVITY", 60),
  pillar("SLEEP", 60),
];
const EARLIER_PILLARS = [
  pillar("BLOOD_PRESSURE", 80),
  pillar("ACTIVITY", 80),
  pillar("SLEEP", 80),
];

/** A twenty-point fall, well clear of the noise floor. */
function fallingDelta(changedAt: Date | null) {
  return attachScoreDelta(
    composite(60, NOW),
    composite(80, new Date(NOW.getTime() - 7 * DAY_MS)),
    composite(80, new Date(NOW.getTime() - 14 * DAY_MS)),
    NOW,
    {
      version: changedAt === null ? 0 : 2,
      changedAt: changedAt?.toISOString() ?? null,
    },
    CURRENT_PILLARS,
    EARLIER_PILLARS,
  );
}

describe("the recipe boundary", () => {
  it("suppresses a fall the person's own settings change straddles", () => {
    const report = fallingDelta(new Date(NOW.getTime() - 3 * DAY_MS));
    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("config_changed");
  });

  it("stays out of the way when the recipe has not moved in the window", () => {
    // The counter-case. A guard that suppressed here would hide every
    // genuine decline an account with a recipe ever has.
    const report = fallingDelta(new Date(NOW.getTime() - 30 * DAY_MS));
    expect(report.deltaReason).toBeNull();
    expect(report.delta).toBe(-20);
  });

  it("stays out of the way for an account that never chose", () => {
    const report = fallingDelta(null);
    expect(report.deltaReason).toBeNull();
    expect(report.delta).toBe(-20);
  });

  it("suppresses at the boundary instant and not one moment past it", () => {
    const previousAt = new Date(NOW.getTime() - 7 * DAY_MS);
    const boundary = (changedAt: Date) =>
      crossesConfigBoundary(
        { version: 1, changedAt: changedAt.toISOString() },
        previousAt,
        NOW,
      );

    // A change on the previous window's own instant is not inside the
    // window: that window was scored under it.
    expect(boundary(previousAt)).toBe(false);
    expect(boundary(new Date(previousAt.getTime() + 1))).toBe(true);
    expect(boundary(NOW)).toBe(true);
    // A change stamped after the current window is a clock that ran
    // ahead, not a comparison to break.
    expect(boundary(new Date(NOW.getTime() + 1))).toBe(false);
  });

  it("refuses to read a boundary it cannot parse, rather than suppressing forever", () => {
    expect(
      crossesConfigBoundary(
        { version: 4, changedAt: "not a date" },
        new Date(NOW.getTime() - 7 * DAY_MS),
        NOW,
      ),
    ).toBe(false);
    expect(
      crossesConfigBoundary(
        { version: 4, changedAt: null },
        new Date(NOW.getTime() - 7 * DAY_MS),
        NOW,
      ),
    ).toBe(false);
  });

  it("carries the resolver's own answer, not a second reading of the blob", () => {
    const changedAt = new Date(NOW.getTime() - 2 * DAY_MS);
    const stored = healthScoreConfigFromSelection({
      selection: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      version: 7,
      changedAt,
    });

    expect(scoreConfigBoundary(resolveHealthScoreConfig(stored))).toEqual({
      version: 7,
      changedAt: changedAt.toISOString(),
    });
    expect(scoreConfigBoundary(resolveHealthScoreConfig(null))).toEqual(
      UNCONFIGURED_SCORE_BOUNDARY,
    );
  });
});

describe("the notice key", () => {
  it("moves when the method moves and when the recipe moves", () => {
    const base = healthScoreNoticeItemKey(2, 3);
    expect(healthScoreNoticeItemKey(3, 3)).not.toBe(base);
    expect(healthScoreNoticeItemKey(2, 4)).not.toBe(base);
    // …and only then. The same pair is the same acknowledgement, so the
    // notice is raised once and dismissed once per recipe version.
    expect(healthScoreNoticeItemKey(2, 3)).toBe(base);
  });

  it("leaves a never-configured account's existing key exactly as it was", () => {
    // Lengthening this key for everybody would orphan every dismissal
    // already in the ledger and re-raise the method notice for the whole
    // install base on upgrade.
    expect(healthScoreNoticeItemKey(2, 0)).toBe("health_score_algorithm:2");
  });

  it("stays a key the dismiss route already accepts", () => {
    // The whole reason for folding the recipe version into this key
    // rather than minting a second notice system: dismissal, the ledger
    // prefix and the score-cache eviction all key on the prefix and need
    // no change to carry the new notice.
    const key = healthScoreNoticeItemKey(2, 5);
    expect(key.startsWith("health_score_algorithm:")).toBe(true);
    expect(isDismissibleItemKey(key)).toBe(true);
    expect(dismissPriorityItemSchema.safeParse({ itemKey: key }).success).toBe(
      true,
    );
  });
});

describe("the seam", () => {
  function day(
    dayKey: string,
    configVersion: number | null,
  ): ScoreSeriesRecord {
    return {
      dayKey,
      composite: 70,
      band: "yellow",
      composition: ["ACTIVITY", "SLEEP", "ADIPOSITY"],
      pillarScores: { ACTIVITY: 70, SLEEP: 70, ADIPOSITY: 70 },
      configVersion,
    };
  }

  it("marks the first day after a change and nothing else", () => {
    const points = scoreSeriesSeams([
      day("2026-08-17", 1),
      day("2026-08-18", 1),
      day("2026-08-19", 2),
      day("2026-08-20", 2),
    ]);

    expect(points.map((point) => point.seamBreak)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("never marks the first day of the series", () => {
    // A beginning is not a break. Flagging it would put a "you changed
    // what counts here" marker on the day someone started.
    expect(scoreSeriesSeams([day("2026-08-20", 3)])[0].seamBreak).toBe(false);
    expect(scoreSeriesSeams([])).toEqual([]);
  });

  it("stays quiet across days that share a recipe", () => {
    const points = scoreSeriesSeams([
      day("2026-08-18", 0),
      day("2026-08-19", 0),
      day("2026-08-20", 0),
    ]);
    expect(points.some((point) => point.seamBreak)).toBe(false);
    expect(scoreCompositeSegments(points)).toHaveLength(1);
  });

  it("orders by day before comparing, so an unordered read cannot invent a seam", () => {
    const points = scoreSeriesSeams([
      day("2026-08-20", 2),
      day("2026-08-18", 1),
      day("2026-08-19", 2),
    ]);
    expect(points.map((point) => point.dayKey)).toEqual([
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
    ]);
    expect(points.map((point) => point.seamBreak)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("treats a day that names no recipe as a break rather than a link", () => {
    const points = scoreSeriesSeams([
      day("2026-08-19", null),
      day("2026-08-20", 1),
    ]);
    expect(points[1].seamBreak).toBe(true);
  });

  it("breaks the composite line and never rejoins it", () => {
    const points = scoreSeriesSeams([
      day("2026-08-17", 1),
      day("2026-08-18", 1),
      day("2026-08-19", 2),
      day("2026-08-20", 2),
    ]);
    const segments = scoreCompositeSegments(points);

    expect(segments).toHaveLength(2);
    expect(segments[0].map((point) => point.dayKey)).toEqual([
      "2026-08-17",
      "2026-08-18",
    ]);
    expect(segments[1].map((point) => point.dayKey)).toEqual([
      "2026-08-19",
      "2026-08-20",
    ]);
    // Every day is in exactly one segment: no day is repeated to make
    // the ends meet, and none is dropped to hide the gap.
    expect(segments.flat().map((point) => point.dayKey)).toEqual(
      points.map((point) => point.dayKey),
    );
  });

  it("keeps a pillar's own row running straight through the seam", () => {
    const points = scoreSeriesSeams([
      { ...day("2026-08-18", 1), pillarScores: { SLEEP: 61 } },
      { ...day("2026-08-19", 2), pillarScores: { SLEEP: 62 } },
      { ...day("2026-08-20", 2), pillarScores: { SLEEP: 63 } },
    ]);

    expect(points[1].seamBreak).toBe(true);
    expect(scorePillarSeries(points, "SLEEP")).toEqual([
      { dayKey: "2026-08-18", score: 61 },
      { dayKey: "2026-08-19", score: 62 },
      { dayKey: "2026-08-20", score: 63 },
    ]);
  });

  it("leaves out a day the pillar did not count on, rather than scoring it zero", () => {
    const points = scoreSeriesSeams([
      { ...day("2026-08-19", 1), pillarScores: { SLEEP: 61 } },
      { ...day("2026-08-20", 1), pillarScores: { ACTIVITY: 70 } },
    ]);
    expect(scorePillarSeries(points, "SLEEP")).toEqual([
      { dayKey: "2026-08-19", score: 61 },
    ]);
  });
});
