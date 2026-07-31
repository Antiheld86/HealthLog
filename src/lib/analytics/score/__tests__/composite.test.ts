import { describe, expect, it } from "vitest";

import { buildOk, deriveCoverage } from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";
import {
  attachScoreDelta,
  computeComposite,
  SCORE_ALGORITHM_CHANGED_AT,
} from "../composite";
import { UNCONFIGURED_SCORE_BOUNDARY } from "../config";
import type { PillarValue, ScorePillarId, ScorePillarResult } from "../types";

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

function pillar(
  id: ScorePillarId,
  score: number,
  options: {
    deltaEligible?: boolean;
    noiseFloor?: number;
    historyDays?: number;
    deltaIdentity?: string;
  } = {},
): ScorePillarResult {
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: options.historyDays ?? 28,
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
    noiseFloor: options.noiseFloor ?? 1,
    deltaEligible: options.deltaEligible ?? true,
    deltaIdentity: options.deltaIdentity ?? id,
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
  return { id, domain: DOMAIN_BY_PILLAR[id], result };
}

function evaluation(
  entries: ScorePillarResult[],
  asOf: Date,
  available = entries.map((entry) => entry.id),
) {
  return computeComposite({
    pillars: entries,
    availablePillars: available,
    asOf,
    configured: false,
  });
}

describe("reference-score composite", () => {
  it("requires three domains and one measured physiological domain", () => {
    const tooNarrow = evaluation(
      [pillar("ACTIVITY", 90), pillar("WELLBEING", 80)],
      NOW,
    );
    expect(tooNarrow.status).toBe("insufficient");

    const eligible = evaluation(
      [pillar("ACTIVITY", 90), pillar("WELLBEING", 80), pillar("SLEEP", 70)],
      NOW,
    );
    expect(eligible.status).toBe("ok");
  });

  it("reports breadth coverage as distinct eligible domains", () => {
    const result = evaluation(
      [
        pillar("BLOOD_PRESSURE", 90),
        pillar("GLYCAEMIA", 85),
        pillar("LIPIDS", 80),
        pillar("ACTIVITY", 75),
      ],
      NOW,
    );

    expect(result.status).toBe("insufficient");
    expect(result.coverage.requiredInputs).toBe(3);
    expect(result.coverage.presentInputs).toBe(2);
    if (result.status === "insufficient") {
      expect(result.reason).toBe("three_domains_required");
    }
  });

  it("uses equal weights in registry order", () => {
    const result = evaluation(
      [
        pillar("SLEEP", 90),
        pillar("BLOOD_PRESSURE", 60),
        pillar("ACTIVITY", 75),
      ],
      NOW,
      ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.score).toBe(75);
      expect(result.value.composition).toEqual([
        "BLOOD_PRESSURE",
        "ACTIVITY",
        "SLEEP",
      ]);
    }
  });

  it("caps the composite band at the worst pillar and names the setter", () => {
    const result = evaluation(
      [
        pillar("BLOOD_PRESSURE", 45),
        pillar("ACTIVITY", 100),
        pillar("SLEEP", 100),
      ],
      NOW,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.score).toBe(82);
      expect(result.value.band).toBe("red");
      expect(result.value.bandSetter).toBe("BLOOD_PRESSURE");
    }
  });

  it("suppresses delta across a composition change", () => {
    const current = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
        pillar("WELLBEING", 80),
      ],
      NOW,
    );
    const previous = evaluation(
      [
        pillar("BLOOD_PRESSURE", 75),
        pillar("ACTIVITY", 75),
        pillar("SLEEP", 75),
      ],
      new Date(NOW.getTime() - 7 * 86_400_000),
    );
    const report = attachScoreDelta(
      current,
      previous,
      previous,
      NOW,
      UNCONFIGURED_SCORE_BOUNDARY,
    );
    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("composition_changed");
  });

  it("suppresses the first comparable eligibility window", () => {
    const current = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
      ],
      NOW,
    );
    const previous = evaluation(
      [
        pillar("BLOOD_PRESSURE", 75),
        pillar("ACTIVITY", 75),
        pillar("SLEEP", 75),
      ],
      new Date(NOW.getTime() - 7 * 86_400_000),
    );
    const previousPrevious = evaluation(
      [pillar("BLOOD_PRESSURE", 70), pillar("ACTIVITY", 70)],
      new Date(NOW.getTime() - 14 * 86_400_000),
    );
    const report = attachScoreDelta(
      current,
      previous,
      previousPrevious,
      NOW,
      UNCONFIGURED_SCORE_BOUNDARY,
    );
    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("first_eligibility_window");
  });

  it("suppresses the algorithm boundary and movements below the combined noise floor", () => {
    const changedAt = new Date(SCORE_ALGORITHM_CHANGED_AT);
    const currentAtBoundary = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
      ],
      changedAt,
    );
    const beforeBoundary = evaluation(
      [
        pillar("BLOOD_PRESSURE", 75),
        pillar("ACTIVITY", 75),
        pillar("SLEEP", 75),
      ],
      new Date(changedAt.getTime() - 7 * 86_400_000),
    );
    const algorithm = attachScoreDelta(
      currentAtBoundary,
      beforeBoundary,
      beforeBoundary,
      changedAt,
      UNCONFIGURED_SCORE_BOUNDARY,
    );
    expect(algorithm.deltaReason).toBe("algorithm_changed");

    const current = evaluation(
      [
        pillar("BLOOD_PRESSURE", 81, { noiseFloor: 4 }),
        pillar("ACTIVITY", 80, { noiseFloor: 4 }),
        pillar("SLEEP", 80, { noiseFloor: 4 }),
      ],
      NOW,
    );
    const previous = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80, { noiseFloor: 4 }),
        pillar("ACTIVITY", 80, { noiseFloor: 4 }),
        pillar("SLEEP", 80, { noiseFloor: 4 }),
      ],
      new Date(NOW.getTime() - 7 * 86_400_000),
    );
    const stablePrior = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80, { noiseFloor: 4 }),
        pillar("ACTIVITY", 80, { noiseFloor: 4 }),
        pillar("SLEEP", 80, { noiseFloor: 4 }),
      ],
      new Date(NOW.getTime() - 14 * 86_400_000),
    );
    const belowNoise = attachScoreDelta(
      current,
      previous,
      stablePrior,
      NOW,
      UNCONFIGURED_SCORE_BOUNDARY,
    );
    expect(belowNoise.delta).toBeNull();
    expect(belowNoise.deltaReason).toBe("below_noise_floor");
  });

  it("excludes slow pillars from the weekly delta", () => {
    const current = evaluation(
      [
        pillar("BLOOD_PRESSURE", 90),
        pillar("ACTIVITY", 90),
        pillar("SLEEP", 90),
        pillar("LIPIDS", 20, { deltaEligible: false }),
      ],
      NOW,
    );
    const previous = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
        pillar("LIPIDS", 100, { deltaEligible: false }),
      ],
      new Date(NOW.getTime() - 7 * 86_400_000),
    );
    const stablePrior = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
        pillar("LIPIDS", 100, { deltaEligible: false }),
      ],
      new Date(NOW.getTime() - 14 * 86_400_000),
    );
    const report = attachScoreDelta(
      current,
      previous,
      stablePrior,
      NOW,
      UNCONFIGURED_SCORE_BOUNDARY,
      [
        pillar("BLOOD_PRESSURE", 90),
        pillar("ACTIVITY", 90),
        pillar("SLEEP", 90),
        pillar("LIPIDS", 20, { deltaEligible: false }),
      ],
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
        pillar("LIPIDS", 100, { deltaEligible: false }),
      ],
    );
    expect(report.delta).toBe(10);
    expect(report.deltaReason).toBeNull();
  });

  it("excludes a pillar whose input mode changed from the delta intersection", () => {
    const currentPillars = [
      pillar("BLOOD_PRESSURE", 80),
      pillar("GLYCAEMIA", 100, { deltaIdentity: "hba1c" }),
      pillar("ACTIVITY", 80),
      pillar("SLEEP", 80),
    ];
    const previousPillars = [
      pillar("BLOOD_PRESSURE", 80),
      pillar("GLYCAEMIA", 20, { deltaIdentity: "fasting_glucose" }),
      pillar("ACTIVITY", 80),
      pillar("SLEEP", 80),
    ];
    const current = evaluation(currentPillars, NOW);
    const previous = evaluation(
      previousPillars,
      new Date(NOW.getTime() - 7 * 86_400_000),
    );
    const stablePrior = evaluation(
      previousPillars,
      new Date(NOW.getTime() - 14 * 86_400_000),
    );

    const report = attachScoreDelta(
      current,
      previous,
      stablePrior,
      NOW,
      UNCONFIGURED_SCORE_BOUNDARY,
      currentPillars,
      previousPillars,
    );

    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("below_noise_floor");
  });
});
