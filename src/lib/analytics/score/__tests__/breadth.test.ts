/**
 * v1.38 — the breadth rule, now a grading rather than a gate, and the
 * proof that both layers still read the same one.
 *
 * This file used to pin the two refusals (`three_domains_required`,
 * `measured_physiological_domain_required`) as the rule's whole output.
 * They are gone: three areas of health is what the score RECOMMENDS, and
 * a set below it is scored and labelled instead of refused. So the cases
 * that asserted a refusal now assert a TIER, which is the same question
 * asked of a rule that answers it differently.
 *
 * What survives unchanged is the reason the file exists. Two layers
 * apply the rule — the settings write and the scorer — and two layers
 * drift. The middle block below drives the real `computeComposite` and
 * asserts it produces a score for exactly the sets the rule admits, and
 * refuses exactly the one it does not.
 *
 * The last block is the counter-case, and it is the one that would catch
 * this change going too far. A rule that has stopped refusing anything
 * is not a graded rule, it is a deleted one, so the empty set must still
 * come back refused — with a reason, from a verdict that carries no
 * tier — and the composite must still say `no_usable_data` rather than
 * inventing a score out of nothing.
 */
import { describe, expect, it } from "vitest";

import { buildOk, deriveCoverage } from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";

import {
  evaluateScoreBreadth,
  SCORE_RECOMMENDED_DOMAINS,
  type ScoreBreadthTier,
} from "../breadth";
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

/**
 * The sets the rule has an opinion about, each with the tier it should
 * reach and whether the set carries a physiological measurement.
 *
 * `tier: null` means refused. Exactly one case is refused, on purpose:
 * every other row in this table used to be a refusal too, and each is
 * now a number somebody gets to see.
 */
const CASES: Array<{
  what: string;
  ids: ScorePillarId[];
  tier: ScoreBreadthTier | null;
  physiological: boolean;
}> = [
  {
    what: "an empty selection",
    ids: [],
    tier: null,
    physiological: false,
  },
  {
    what: "activity alone, which measures nothing physiological",
    ids: ["ACTIVITY"],
    tier: "minimal",
    physiological: false,
  },
  {
    what: "the two non-physiological pillars together",
    ids: ["ACTIVITY", "WELLBEING"],
    tier: "partial",
    physiological: false,
  },
  {
    what: "the whole cardiometabolic triple, which is one area",
    ids: ["BLOOD_PRESSURE", "GLYCAEMIA", "LIPIDS"],
    tier: "minimal",
    physiological: true,
  },
  {
    what: "one physiological pillar alone",
    ids: ["BLOOD_PRESSURE"],
    tier: "minimal",
    physiological: true,
  },
  {
    what: "two areas with a physiological pillar",
    ids: ["BLOOD_PRESSURE", "ACTIVITY"],
    tier: "partial",
    physiological: true,
  },
  {
    what: "three areas including a physiological pillar",
    ids: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
    tier: "full",
    physiological: true,
  },
  {
    what: "three areas where two pillars share one",
    ids: ["BLOOD_PRESSURE", "LIPIDS", "ACTIVITY", "SLEEP"],
    tier: "full",
    physiological: true,
  },
  {
    what: "every pillar",
    ids: [...SCORE_PILLAR_IDS],
    tier: "full",
    physiological: true,
  },
];

describe("evaluateScoreBreadth", () => {
  for (const { what, ids, tier, physiological } of CASES) {
    it(`${tier === null ? "refuses" : `grades ${tier} for`} ${what}`, () => {
      const verdict = evaluateScoreBreadth(ids);
      expect(verdict.ok).toBe(tier !== null);
      expect(verdict.tier).toBe(tier);
      expect(verdict.physiological).toBe(physiological);
      expect(verdict.reason).toBe(tier === null ? "no_pillars_selected" : null);
    });
  }

  it("grades on distinct areas, not on how many pillars were named", () => {
    // The whole point of the domain map. Three pillars, one area: this is
    // the set the old rule refused outright and the set most likely to be
    // graded `full` by a client that counts `composition` instead.
    const triple = evaluateScoreBreadth([
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "LIPIDS",
    ]);
    expect(triple.tier).toBe("minimal");
    expect(triple.domains).toEqual(["cardiometabolic"]);
  });

  it("puts the recommendation at three areas and reaches full there", () => {
    expect(SCORE_RECOMMENDED_DOMAINS).toBe(3);
    expect(
      evaluateScoreBreadth(["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"]).domains,
    ).toHaveLength(SCORE_RECOMMENDED_DOMAINS);
  });

  it("reports a missing physiological measure without withholding the score", () => {
    // The old rule's sharpest edge, inverted on purpose: activity alone
    // used to be told "no score for you" and is now told what its score
    // rests on. `physiological: false` is the whole of that caveat.
    const verdict = evaluateScoreBreadth(["ACTIVITY"]);
    expect(verdict.ok).toBe(true);
    expect(verdict.physiological).toBe(false);
  });
});

describe("the scorer grades exactly what the rule grades", () => {
  for (const { what, ids, tier, physiological } of CASES) {
    it(`agrees on ${what}`, () => {
      const composite = computeComposite({
        pillars: ids.map((id) => pillar(id)),
        availablePillars: ids,
        asOf: NOW,
        configured: false,
      });
      const verdict = evaluateScoreBreadth(ids);
      expect(composite.status).toBe(verdict.ok ? "ok" : "insufficient");
      if (composite.status === "ok") {
        expect(composite.value.scoreBasis).toEqual({
          domains: verdict.domains.length,
          recommended: SCORE_RECOMMENDED_DOMAINS,
          tier,
          physiological,
        });
      }
    });
  }

  it("computes the same number at every tier", () => {
    // No discount for the pillars somebody does not track. A mean of 80
    // and 60 is 70 whether it is drawn from two areas or five, because
    // any other answer would be a target nobody set.
    const narrow = computeComposite({
      pillars: [pillar("BLOOD_PRESSURE", 80), pillar("ACTIVITY", 60)],
      availablePillars: ["BLOOD_PRESSURE", "ACTIVITY"],
      asOf: NOW,
      configured: false,
    });
    const broad = computeComposite({
      pillars: [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 60),
        pillar("SLEEP", 70),
      ],
      availablePillars: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      asOf: NOW,
      configured: false,
    });
    expect(narrow.status).toBe("ok");
    expect(broad.status).toBe("ok");
    if (narrow.status !== "ok" || broad.status !== "ok") return;
    expect(narrow.value.score).toBe(70);
    expect(broad.value.score).toBe(70);
    expect(narrow.value.scoreBasis?.tier).toBe("partial");
    expect(broad.value.scoreBasis?.tier).toBe("full");
  });
});

describe("the refusal that is left still refuses", () => {
  // A rule that grades everything has stopped being a rule. These are the
  // assertions that fail if the grading is widened until nothing can be
  // turned away.
  it("gives the empty set a reason and no tier", () => {
    const verdict = evaluateScoreBreadth([]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("no_pillars_selected");
    expect(verdict.tier).toBeNull();
    expect(verdict.domains).toEqual([]);
  });

  it("refuses a composite whose pillars are all insufficient", () => {
    // The realistic shape of nothing: pillars are SELECTED and graded,
    // every one of them came back short. An empty `availablePillars`
    // array would prove less, because a set nobody chose is trivially
    // empty; this is an account that chose four and has data for none.
    const selection: ScorePillarId[] = [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "WELLBEING",
    ];
    const composite = computeComposite({
      pillars: selection.map((id) => ({
        id,
        domain: SCORE_PILLAR_DOMAINS[id],
        result: {
          status: "insufficient",
          coverage: deriveCoverage({
            requiredInputs: 1,
            presentInputs: 0,
            historyDays: 0,
            missing: [id],
            fullHistoryDays: 28,
          }).coverage,
          provenance: {
            inputs: [],
            source: "none",
            windowDays: 28,
            computedAt: NOW.toISOString(),
          },
          reason: "below_day_floor_or_stale",
        },
      })),
      availablePillars: selection,
      asOf: NOW,
      configured: false,
    });
    expect(composite.status).toBe("insufficient");
    if (composite.status !== "insufficient") return;
    expect(composite.reason).toBe("no_usable_data");
  });
});

describe("the pillar-to-domain map", () => {
  it("covers every pillar in the registry", () => {
    for (const id of SCORE_PILLAR_IDS) {
      expect(SCORE_PILLAR_DOMAINS[id]).toBeTruthy();
    }
  });

  it("keeps the three cardiometabolic pillars in one domain", () => {
    // The triple-count is the reason a four-pillar selection can still be
    // a one-area score, so it is pinned rather than left to the map's
    // shape.
    expect(SCORE_PILLAR_DOMAINS.BLOOD_PRESSURE).toBe("cardiometabolic");
    expect(SCORE_PILLAR_DOMAINS.GLYCAEMIA).toBe("cardiometabolic");
    expect(SCORE_PILLAR_DOMAINS.LIPIDS).toBe("cardiometabolic");
  });
});
