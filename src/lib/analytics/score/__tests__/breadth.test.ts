/**
 * v1.35.0 — the breadth rule, and the proof that both layers apply the
 * same one.
 *
 * The settings write refuses a selection that cannot produce a score;
 * the scorer refuses to produce one from a set that fails the same rule.
 * Two layers, on purpose. The danger in two layers is that they drift,
 * so the last block below drives the real `computeComposite` and asserts
 * it refuses exactly the sets `evaluateScoreBreadth` refuses, with the
 * same reason.
 */
import { describe, expect, it } from "vitest";

import { buildOk, deriveCoverage } from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";

import { evaluateScoreBreadth } from "../breadth";
import { computeComposite } from "../composite";
import {
  SCORE_PILLAR_DOMAINS,
  SCORE_PILLAR_IDS,
  type PillarValue,
  type ScorePillarId,
  type ScorePillarResult,
} from "../types";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function pillar(id: ScorePillarId, score = 80): ScorePillarResult {
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
      label: `${score}`,
      value: score,
      unit: "score",
      asOf: NOW.toISOString(),
      sources: ["MANUAL"],
    },
    reference: {
      kind: "guideline-band",
      low: 0,
      high: 100,
      label: "test reference",
      source: "Test 2026",
    },
    noiseFloor: 1,
    deltaEligible: true,
    deltaIdentity: id,
  };
  const result: Derived<PillarValue> = buildOk({
    value,
    coverage,
    confidence,
    provenance: {
      inputs: [id],
      source: "live",
      windowDays: 28,
      computedAt: NOW.toISOString(),
    },
  });
  return { id, domain: SCORE_PILLAR_DOMAINS[id], result };
}

/** The sets the rule has an opinion about, each with the expected verdict. */
const CASES: Array<{
  what: string;
  ids: ScorePillarId[];
  reason: string | null;
}> = [
  {
    what: "the two non-physiological pillars alone",
    ids: ["ACTIVITY", "WELLBEING"],
    reason: "measured_physiological_domain_required",
  },
  {
    what: "activity and wellbeing plus nothing measured",
    ids: ["ACTIVITY"],
    reason: "measured_physiological_domain_required",
  },
  {
    what: "an empty selection",
    ids: [],
    reason: "measured_physiological_domain_required",
  },
  {
    what: "the whole cardiometabolic triple, which is one domain",
    ids: ["BLOOD_PRESSURE", "GLYCAEMIA", "LIPIDS"],
    reason: "three_domains_required",
  },
  {
    what: "two domains with a physiological pillar",
    ids: ["BLOOD_PRESSURE", "ACTIVITY"],
    reason: "three_domains_required",
  },
  {
    what: "three domains including a physiological pillar",
    ids: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
    reason: null,
  },
  {
    what: "three domains where two pillars share one",
    ids: ["BLOOD_PRESSURE", "LIPIDS", "ACTIVITY", "SLEEP"],
    reason: null,
  },
  { what: "every pillar", ids: [...SCORE_PILLAR_IDS], reason: null },
];

describe("evaluateScoreBreadth", () => {
  for (const { what, ids, reason } of CASES) {
    it(`${reason ? "refuses" : "accepts"} ${what}`, () => {
      const verdict = evaluateScoreBreadth(ids);
      expect(verdict.ok).toBe(reason === null);
      expect(verdict.reason).toBe(reason);
    });
  }

  it("names the missing physiological measure before the missing domain", () => {
    // Three domains, none of them a physiological measure is impossible
    // with the current registry, so the precedence shows on the set that
    // fails both: one non-physiological pillar, one domain.
    expect(evaluateScoreBreadth(["ACTIVITY"]).reason).toBe(
      "measured_physiological_domain_required",
    );
  });

  it("reports the distinct domains the set spans", () => {
    expect(
      evaluateScoreBreadth(["BLOOD_PRESSURE", "GLYCAEMIA", "LIPIDS"]).domains,
    ).toEqual(["cardiometabolic"]);
  });
});

describe("the scorer refuses exactly what the write refuses", () => {
  for (const { what, ids, reason } of CASES) {
    it(`agrees on ${what}`, () => {
      const composite = computeComposite({
        pillars: ids.map((id) => pillar(id)),
        availablePillars: ids,
        asOf: NOW,
      });
      const verdict = evaluateScoreBreadth(ids);
      expect(composite.status).toBe(verdict.ok ? "ok" : "insufficient");
      if (composite.status === "insufficient") {
        expect(composite.reason).toBe(verdict.reason);
      }
    });
  }
});

describe("the pillar-to-domain map", () => {
  it("covers every pillar in the registry", () => {
    for (const id of SCORE_PILLAR_IDS) {
      expect(SCORE_PILLAR_DOMAINS[id]).toBeTruthy();
    }
  });

  it("keeps the three cardiometabolic pillars in one domain", () => {
    // The triple-count is the reason a five-pillar selection can still
    // fail the rule, so it is pinned rather than left to the map's shape.
    expect(SCORE_PILLAR_DOMAINS.BLOOD_PRESSURE).toBe("cardiometabolic");
    expect(SCORE_PILLAR_DOMAINS.GLYCAEMIA).toBe("cardiometabolic");
    expect(SCORE_PILLAR_DOMAINS.LIPIDS).toBe("cardiometabolic");
  });
});
