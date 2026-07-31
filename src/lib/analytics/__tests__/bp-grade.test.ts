/**
 * v1.15.12 A1 — unit pins for the graded BP pillar score.
 *
 * The maintainer's apps01 profile (under-65 ceiling 129/79, avg 134/87)
 * is the canonical regression: the binary all-time in-target rate read
 * ~10-16/100; the graded score must land in the borderline-stage-1 band
 * (low-to-mid 50s), not in the catastrophic band.
 */
import { describe, expect, it } from "vitest";
import {
  gradeBpScore,
  gradeBpScoreFromSeries,
  type BpPairPoint,
} from "../bp-grade";
import type { BpTargets } from "../bp-targets";

// Under-65 ESH band — the maintainer's age band.
const UNDER65: BpTargets = {
  sysLow: 120,
  sysHigh: 129,
  diaLow: 70,
  diaHigh: 79,
};

/**
 * The score alone, for the arithmetic pins below. `gradeBpScore` returns
 * the score together with the basis that produced it; the basis has its
 * own describe block further down.
 */
function bpScore(input: { sys: number; dia: number; target: BpTargets }) {
  return gradeBpScore(input).score;
}

describe("gradeBpScore", () => {
  it("grades the maintainer's 134/87 into the borderline band [45,60]", () => {
    const score = bpScore({ sys: 134, dia: 87, target: UNDER65 });
    expect(score).toBeGreaterThanOrEqual(45);
    expect(score).toBeLessThanOrEqual(60);
  });

  it("grades a well-controlled 120/78 at or above 85", () => {
    expect(
      bpScore({ sys: 120, dia: 78, target: UNDER65 }),
    ).toBeGreaterThanOrEqual(85);
  });

  it("grades a textbook-normal 118/76 very high (≈100)", () => {
    expect(
      bpScore({ sys: 118, dia: 76, target: UNDER65 }),
    ).toBeGreaterThanOrEqual(88);
  });

  it("grades an uncontrolled 160/100 at or below 30", () => {
    expect(
      bpScore({ sys: 160, dia: 100, target: UNDER65 }),
    ).toBeLessThanOrEqual(30);
  });

  it("takes the WORSE axis — a single high diastolic drags the score down", () => {
    // sys perfect (118), dia far over (95): the worst axis should win.
    const sysOk = bpScore({ sys: 118, dia: 78, target: UNDER65 });
    const diaHigh = bpScore({ sys: 118, dia: 95, target: UNDER65 });
    expect(diaHigh).toBeLessThan(sysOk);
  });

  it("is monotonic — higher BP never scores better", () => {
    const a = bpScore({ sys: 130, dia: 82, target: UNDER65 });
    const b = bpScore({ sys: 140, dia: 88, target: UNDER65 });
    const c = bpScore({ sys: 150, dia: 95, target: UNDER65 });
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("has no cliff — a one-mmHg change moves the score by a small amount", () => {
    const at = bpScore({ sys: 129, dia: 79, target: UNDER65 });
    const justOver = bpScore({ sys: 130, dia: 79, target: UNDER65 });
    expect(at - justOver).toBeLessThanOrEqual(5);
    expect(at).toBeGreaterThanOrEqual(justOver);
  });

  it("penalises hypotension below the clinical floor (no longer reads ~100)", () => {
    // 85/45 is 5 mmHg below both floors (sys 90 / dia 50). The continuous
    // hypo curve gives a gentle penalty near the floor (5 below ≈ 85),
    // clearly below the optimal plateau of 100.
    const low = bpScore({ sys: 85, dia: 45, target: UNDER65 });
    expect(low).toBeLessThan(100);
    expect(low).toBeGreaterThanOrEqual(80);
    // A markedly low reading is penalised much harder.
    const veryLow = bpScore({ sys: 70, dia: 40, target: UNDER65 });
    expect(veryLow).toBeLessThan(low);
    expect(veryLow).toBeLessThanOrEqual(45);
  });

  it("has NO hypotension cliff — the floor boundary is continuous on both axes", () => {
    // Audit HIGH-1: above the floor the score sits on the optimal plateau
    // (100); the old below-floor branch jumped to ~81 at 1 mmHg under,
    // a 19-point cliff. The dedicated hypo curve starts at 100 AT the
    // floor and descends smoothly. Walk across the systolic floor (90):
    // dia 66 sits on the optimal plateau (offset −13 → 100) so the
    // systolic axis is the worst-of(sys,dia) winner across the walk.
    const sysWalk = [92, 91, 90, 89, 88].map((sys) =>
      bpScore({ sys, dia: 66, target: UNDER65 }),
    );
    // AT and ABOVE the floor sit on the plateau (100).
    expect(sysWalk[2]).toBe(100); // sys 90
    expect(sysWalk[1]).toBe(100); // sys 91
    expect(sysWalk[0]).toBe(100); // sys 92
    // Every per-step delta is small (no >5-point boundary jump) and the
    // score is monotonic non-increasing as BP drops below the floor.
    for (let i = 0; i < sysWalk.length - 1; i++) {
      const delta = sysWalk[i] - sysWalk[i + 1];
      expect(delta).toBeGreaterThanOrEqual(0); // non-increasing as BP drops
      expect(delta).toBeLessThanOrEqual(5); // no cliff
    }

    // Walk across the diastolic floor (50). Hold sys comfortably normal so
    // the diastolic axis is the worst-of(sys,dia) winner throughout.
    // sys 117 sits on the optimal plateau (offset −12 → 100) so the
    // diastolic axis is the worst-of(sys,dia) winner across the walk.
    const diaWalk = [52, 51, 50, 49, 48].map((dia) =>
      bpScore({ sys: 117, dia, target: UNDER65 }),
    );
    expect(diaWalk[2]).toBe(100); // dia 50
    expect(diaWalk[1]).toBe(100); // dia 51
    expect(diaWalk[0]).toBe(100); // dia 52
    for (let i = 0; i < diaWalk.length - 1; i++) {
      const delta = diaWalk[i] - diaWalk[i + 1];
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThanOrEqual(5);
    }
  });

  it("descends smoothly further below the floor (mirrors over-target steepness)", () => {
    // floor → 100, floor−10 → ~70, floor−20 → ~45, floor−30 → ~20.
    // dia 66 stays on the plateau so the systolic axis is the winner.
    expect(bpScore({ sys: 90, dia: 66, target: UNDER65 })).toBe(100);
    expect(bpScore({ sys: 80, dia: 66, target: UNDER65 })).toBe(70);
    expect(bpScore({ sys: 70, dia: 66, target: UNDER65 })).toBe(45);
    expect(bpScore({ sys: 60, dia: 66, target: UNDER65 })).toBe(20);
    // Never negative on an extreme low.
    expect(
      bpScore({ sys: 30, dia: 20, target: UNDER65 }),
    ).toBeGreaterThanOrEqual(0);
  });

  it("preserves the audit fairness anchors (134/87 → 57, 165/105 → 22)", () => {
    expect(bpScore({ sys: 134, dia: 87, target: UNDER65 })).toBe(57);
    expect(bpScore({ sys: 165, dia: 105, target: UNDER65 })).toBe(22);
  });
});

describe("gradeBpScoreFromSeries", () => {
  const NOW = new Date("2026-06-07T12:00:00.000Z");
  const daysAgo = (n: number): Date =>
    new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  it("returns null for an empty series", () => {
    expect(
      gradeBpScoreFromSeries({ pairs: [], target: UNDER65, now: NOW }),
    ).toBeNull();
  });

  it("weights recent readings more — recent improvement lifts the score", () => {
    // Old readings high, recent readings well-controlled.
    const pairs: BpPairPoint[] = [
      { at: daysAgo(300), sys: 160, dia: 100 },
      { at: daysAgo(280), sys: 158, dia: 98 },
      { at: daysAgo(5), sys: 120, dia: 76 },
      { at: daysAgo(2), sys: 119, dia: 75 },
      { at: daysAgo(0), sys: 121, dia: 77 },
    ];
    const recencyWeighted = gradeBpScoreFromSeries({
      pairs,
      target: UNDER65,
      now: NOW,
    });
    // A flat (unweighted) mean would be dragged toward ~145/90; the
    // recency-weighted representative should read close to the recent
    // well-controlled cluster.
    expect(recencyWeighted).not.toBeNull();
    expect(recencyWeighted!.score).toBeGreaterThanOrEqual(80);
  });

  it("matches the single-reading grade when every pair is today", () => {
    const pairs: BpPairPoint[] = [
      { at: NOW, sys: 134, dia: 87 },
      { at: NOW, sys: 134, dia: 87 },
    ];
    expect(
      gradeBpScoreFromSeries({ pairs, target: UNDER65, now: NOW }),
    ).toEqual(gradeBpScore({ sys: 134, dia: 87, target: UNDER65 }));
  });

  it("rollup (per-day-mean + count) and live (per-event) agree on the same data", () => {
    // Audit HIGH-2 regression guard. A multi-reading high day today
    // (4× 150/95) plus a calm day yesterday (1× 115/72). The live path
    // grades the 5 per-event pairs; the rollup path grades the two per-day
    // MEAN pairs but weights today's mean by its count (4). Both must
    // produce the same graded score, otherwise the BP pillar diverges by
    // up to ~20 points depending on DAY-bucket warmth.
    const today = daysAgo(0);
    const yesterday = daysAgo(1);

    // Live: one pair per event (count defaults to 1).
    const livePairs: BpPairPoint[] = [
      { at: today, sys: 150, dia: 95 },
      { at: today, sys: 150, dia: 95 },
      { at: today, sys: 150, dia: 95 },
      { at: today, sys: 150, dia: 95 },
      { at: yesterday, sys: 115, dia: 72 },
    ];
    // Rollup: one per-day-MEAN pair, weighted by perDayPairCount.
    const rollupPairs: BpPairPoint[] = [
      { at: today, sys: 150, dia: 95, count: 4 },
      { at: yesterday, sys: 115, dia: 72, count: 1 },
    ];

    const live = gradeBpScoreFromSeries({
      pairs: livePairs,
      target: UNDER65,
      now: NOW,
    });
    const rollup = gradeBpScoreFromSeries({
      pairs: rollupPairs,
      target: UNDER65,
      now: NOW,
    });
    expect(live).not.toBeNull();
    expect(rollup).not.toBeNull();
    expect(Math.abs(live!.score - rollup!.score)).toBeLessThanOrEqual(1);
  });
});
