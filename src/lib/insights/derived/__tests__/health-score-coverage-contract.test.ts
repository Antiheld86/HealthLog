/**
 * v1.35.0 — what the Health Score's published coverage is allowed to claim.
 *
 * Two claims are pinned here, because both quietly became wrong the moment
 * a person could choose which pillars count.
 *
 * 1. **The denominator.** A person who counts four pillars must not be
 *    measured against the eight-pillar catalogue. The registry's
 *    `HEALTH_SCORE` entry lists all eight and reads like the recipe, so
 *    the first test states plainly where the published denominator comes
 *    from instead: `computeComposite`, over the composition the resolver
 *    hands it. If someone ever wires the static list into the coverage
 *    model, this goes red.
 * 2. **The missing list.** `coverage.missing` drives "track these to
 *    sharpen this". A pillar somebody deliberately took out of their
 *    score must never appear there, or the app asks for data in the voice
 *    of the person's own settings. The counter-test keeps that honest: a
 *    pillar they KEPT and have no data for still shows up, so the first
 *    assertion is not passing because the list is empty by construction.
 *
 * The composition comes from `resolveHealthScoreConfig` rather than a
 * hand-written array, so the test exercises the same narrowing the reader
 * does instead of asserting against a set it invented.
 */
import { describe, expect, it } from "vitest";

import { computeComposite } from "@/lib/analytics/score/composite";
import { SCORE_RECOMMENDED_DOMAINS } from "@/lib/analytics/score/breadth";
import {
  healthScoreConfigFromSelection,
  resolveHealthScoreConfig,
} from "@/lib/analytics/score/config";
import {
  SCORE_PILLAR_DOMAINS,
  SCORE_PILLAR_IDS,
  type PillarValue,
  type ScorePillarId,
  type ScorePillarResult,
} from "@/lib/analytics/score/types";
import { buildInsufficient, buildOk, deriveCoverage } from "../coverage";
import { getDerivedMetricMeta } from "../registry";
import type { Derived } from "../types";

const NOW = new Date("2026-08-20T12:00:00.000Z");

/** A pillar with data, scored and eligible. */
function scored(id: ScorePillarId, score = 80): ScorePillarResult {
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

/** A pillar the account tracks nothing for. */
function noData(id: ScorePillarId): ScorePillarResult {
  const result: Derived<PillarValue> = buildInsufficient({
    coverage: {
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: [id],
    },
    provenance: {
      inputs: [id],
      source: "none",
      windowDays: 0,
      computedAt: NOW.toISOString(),
    },
    reason: "notTracked",
  });
  return { id, domain: SCORE_PILLAR_DOMAINS[id], result };
}

/**
 * Every pillar in the catalogue, scored when it has data. The scorer
 * always produces a row per pillar; the config decides which rows count,
 * which is exactly the distinction these tests are about.
 */
function allPillars(withData: readonly ScorePillarId[]): ScorePillarResult[] {
  const present = new Set(withData);
  return SCORE_PILLAR_IDS.map((id) =>
    present.has(id) ? scored(id) : noData(id),
  );
}

/** The reader's own narrowing: the stored recipe, resolved. */
function compositionFor(selection: readonly ScorePillarId[]): ScorePillarId[] {
  const blob = healthScoreConfigFromSelection({
    selection,
    version: 1,
    changedAt: NOW,
  });
  return resolveHealthScoreConfig(blob).pillars;
}

describe("Health Score coverage contract", () => {
  it("does not measure a four-pillar account against the whole catalogue", () => {
    const selection: ScorePillarId[] = [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
    ];
    const availablePillars = compositionFor(selection);
    expect(availablePillars).toEqual(selection);

    const composite = computeComposite({
      pillars: allPillars(selection),
      availablePillars,
      // An authored recipe: the person took four pillars out.
      configured: true,
      asOf: NOW,
    });

    expect(composite.status).toBe("ok");
    // The catalogue is wider than the selection and must not be the
    // yardstick.
    expect(SCORE_PILLAR_IDS.length).toBeGreaterThan(selection.length);
    expect(composite.coverage.requiredInputs).not.toBe(SCORE_PILLAR_IDS.length);
    // The denominator is the breadth rule applied to the person's own set,
    // so it can never exceed what they chose to count.
    expect(composite.coverage.requiredInputs).toBe(SCORE_RECOMMENDED_DOMAINS);
    expect(composite.coverage.requiredInputs).toBeLessThanOrEqual(
      selection.length,
    );
    expect(composite.coverage.presentInputs).toBe(
      composite.coverage.requiredInputs,
    );
    if (composite.status !== "ok") throw new Error("unreachable");
    // Fully covered means fully covered: four of four counted pillars have
    // data, so nothing about the ones they left out may pull this down.
    expect(composite.confidence.score).toBe(100);
    expect(composite.value.composition).toEqual(selection);
  });

  it("never asks for data from a pillar the person took out of the score", () => {
    const selection: ScorePillarId[] = [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
    ];
    const composite = computeComposite({
      pillars: allPillars(selection),
      availablePillars: compositionFor(selection),
      // An authored recipe.
      configured: true,
      asOf: NOW,
    });

    expect(composite.coverage.missing).toEqual([]);
  });

  it("still asks for data from a pillar the person kept", () => {
    // The same four pillars have data; the difference is that this account
    // counts the whole catalogue, so the blanks are genuinely missing
    // coverage.
    const withData: ScorePillarId[] = [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
    ];
    const composite = computeComposite({
      pillars: allPillars(withData),
      availablePillars: compositionFor(SCORE_PILLAR_IDS),
      // The full catalogue is this account's default, not a choice.
      configured: false,
      asOf: NOW,
    });

    // Named by DOMAIN, not by pillar: glycaemia and lipids are blank too,
    // but blood pressure already covers the area they sit in, so wellbeing
    // is the one area with nothing behind it. The previous case's `missing`
    // was empty, which is the contrast that makes this assertion mean
    // something.
    expect(composite.coverage.missing).toEqual(["wellbeing"]);
  });

  it("keeps the registry's HEALTH_SCORE inputs equal to the score catalogue", () => {
    const meta = getDerivedMetricMeta("HEALTH_SCORE");
    expect(meta).not.toBeNull();
    expect(meta?.inputs).toEqual([...SCORE_PILLAR_IDS]);
    // Non-vacuity: the comparison is against the live catalogue, and it
    // does distinguish. A list one pillar short is not equal.
    expect(meta?.inputs).not.toEqual(SCORE_PILLAR_IDS.slice(0, -1));
  });
});
