import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
} from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";

import {
  SCORE_PILLAR_IDS,
  SCORE_VERSION,
  type CompositeValue,
  type HealthScoreReport,
  type ScoreBand,
  type ScorePillarId,
  type ScorePillarResult,
} from "./types";
import { mean, provenance, scoreBand } from "./shared";
import { evaluateScoreBreadth, SCORE_MIN_ELIGIBLE_DOMAINS } from "./breadth";

export const SCORE_ALGORITHM_CHANGED_AT = "2026-07-28T00:00:00.000Z";

// The rule itself lives in `./breadth`, where the settings write reads it
// too. Re-exported here because this is where every existing caller looks
// for it.
export { SCORE_MIN_ELIGIBLE_DOMAINS };

const BAND_RANK: Record<ScoreBand, number> = {
  green: 2,
  yellow: 1,
  red: 0,
};

export interface CompositeInput {
  pillars: ScorePillarResult[];
  availablePillars: ScorePillarId[];
  asOf: Date;
}

function orderedUnique(ids: readonly ScorePillarId[]): ScorePillarId[] {
  const present = new Set(ids);
  return SCORE_PILLAR_IDS.filter((id) => present.has(id));
}

export function computeComposite(
  input: CompositeInput,
): Derived<CompositeValue> {
  const available = orderedUnique(input.availablePillars);
  const byId = new Map(input.pillars.map((pillar) => [pillar.id, pillar]));
  const eligible = available
    .map((id) => byId.get(id))
    .filter(
      (pillar): pillar is ScorePillarResult => pillar?.result.status === "ok",
    );
  const composition = eligible.map((pillar) => pillar.id);
  const eligibleDomains = new Set(eligible.map((pillar) => pillar.domain));
  const breadth = evaluateScoreBreadth(composition);
  const availableDomains = new Set(
    input.pillars
      .filter((pillar) => available.includes(pillar.id))
      .map((pillar) => pillar.domain),
  );
  const missing = [...availableDomains].filter(
    (domain) => !eligibleDomains.has(domain),
  );
  const historyDays = eligible.reduce(
    (minimum, pillar) =>
      pillar.result.status === "ok"
        ? Math.min(minimum, pillar.result.coverage.historyDays)
        : minimum,
    Number.POSITIVE_INFINITY,
  );
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: SCORE_MIN_ELIGIBLE_DOMAINS,
    presentInputs: eligibleDomains.size,
    historyDays: Number.isFinite(historyDays) ? historyDays : 0,
    missing,
    fullHistoryDays: 28,
  });
  const compositeProvenance = provenance({
    inputs: composition,
    source:
      eligible.length > 0 &&
      eligible.every(
        (pillar) =>
          pillar.result.provenance.source !== "live" &&
          pillar.result.provenance.source !== "none",
      )
        ? "DAY"
        : eligible.length > 0
          ? "live"
          : "none",
    windowDays: Math.max(
      0,
      ...eligible.map((pillar) => pillar.result.provenance.windowDays),
    ),
    asOf: input.asOf,
  });

  if (!breadth.ok) {
    return buildInsufficient({
      coverage,
      provenance: compositeProvenance,
      reason: breadth.reason,
    });
  }

  const values = eligible.map((pillar) => {
    if (pillar.result.status !== "ok") {
      throw new Error("Eligible score pillar lost its narrowed state");
    }
    return pillar.result.value;
  });
  const score = Math.round(mean(values.map((value) => value.score)));
  const meanBand = scoreBand(score);
  const bandSetterIndex = values.reduce(
    (worstIndex, value, index) =>
      BAND_RANK[scoreBand(value.score)] <
      BAND_RANK[scoreBand(values[worstIndex].score)]
        ? index
        : worstIndex,
    0,
  );
  const bandSetterValue = values[bandSetterIndex];
  const worstBand = scoreBand(bandSetterValue.score);
  const band =
    BAND_RANK[worstBand] < BAND_RANK[meanBand] ? worstBand : meanBand;
  const deltaValues = values.filter((value) => value.deltaEligible);
  const noiseFloor =
    deltaValues.length === 0
      ? 0
      : Math.ceil(
          Math.sqrt(
            deltaValues.reduce((sum, value) => sum + value.noiseFloor ** 2, 0),
          ) / deltaValues.length,
        );

  return buildOk({
    value: {
      score,
      band,
      bandSetter:
        BAND_RANK[worstBand] < BAND_RANK[meanBand]
          ? composition[bandSetterIndex]
          : null,
      composition,
      noiseFloor,
      scoreVersion: SCORE_VERSION,
    },
    coverage,
    confidence,
    provenance: compositeProvenance,
  });
}

function sameComposition(
  left: Derived<CompositeValue>,
  right: Derived<CompositeValue>,
): boolean {
  return (
    left.status === "ok" &&
    right.status === "ok" &&
    left.value.composition.length === right.value.composition.length &&
    left.value.composition.every(
      (pillar, index) => pillar === right.value.composition[index],
    )
  );
}

function comparableDynamicPillars(
  report: Derived<CompositeValue>,
  other: Derived<CompositeValue>,
  pillars: ScorePillarResult[],
  otherPillars: ScorePillarResult[],
): {
  current: number;
  previous: number;
  noiseFloor: number;
} | null {
  if (report.status !== "ok" || other.status !== "ok") return null;
  const otherById = new Map(otherPillars.map((pillar) => [pillar.id, pillar]));
  const pairs = pillars.flatMap((pillar) => {
    const previous = otherById.get(pillar.id);
    if (
      !report.value.composition.includes(pillar.id) ||
      !other.value.composition.includes(pillar.id) ||
      pillar.result.status !== "ok" ||
      previous?.result.status !== "ok" ||
      !pillar.result.value.deltaEligible ||
      !previous.result.value.deltaEligible ||
      pillar.result.value.deltaIdentity !== previous.result.value.deltaIdentity
    ) {
      return [];
    }
    return [
      {
        current: pillar.result.value.score,
        previous: previous.result.value.score,
        noiseFloor: Math.max(
          pillar.result.value.noiseFloor,
          previous.result.value.noiseFloor,
        ),
      },
    ];
  });
  if (pairs.length === 0) return null;
  return {
    current: mean(pairs.map((pair) => pair.current)),
    previous: mean(pairs.map((pair) => pair.previous)),
    noiseFloor: Math.ceil(
      Math.sqrt(pairs.reduce((sum, pair) => sum + pair.noiseFloor ** 2, 0)) /
        pairs.length,
    ),
  };
}

export function attachScoreDelta(
  current: Derived<CompositeValue>,
  previous: Derived<CompositeValue>,
  previousPrevious: Derived<CompositeValue>,
  asOf: Date,
  currentPillars: ScorePillarResult[] = [],
  previousPillars: ScorePillarResult[] = [],
): Pick<HealthScoreReport, "delta" | "deltaReason"> {
  if (current.status !== "ok") {
    return { delta: null, deltaReason: "no_current_score" };
  }
  if (previous.status !== "ok") {
    return { delta: null, deltaReason: "no_previous_window" };
  }

  const previousAt = new Date(previous.provenance.computedAt);
  const boundary = new Date(SCORE_ALGORITHM_CHANGED_AT);
  if (
    current.value.scoreVersion !== previous.value.scoreVersion ||
    (asOf >= boundary && previousAt < boundary)
  ) {
    return { delta: null, deltaReason: "algorithm_changed" };
  }
  if (!sameComposition(current, previous)) {
    return { delta: null, deltaReason: "composition_changed" };
  }
  if (
    previousPrevious.status !== "ok" ||
    !sameComposition(previous, previousPrevious)
  ) {
    return { delta: null, deltaReason: "first_eligibility_window" };
  }

  const comparable =
    currentPillars.length > 0 || previousPillars.length > 0
      ? comparableDynamicPillars(
          current,
          previous,
          currentPillars,
          previousPillars,
        )
      : null;
  if (
    (currentPillars.length > 0 || previousPillars.length > 0) &&
    !comparable
  ) {
    return { delta: null, deltaReason: "composition_changed" };
  }
  const delta = Math.round(
    (comparable?.current ?? current.value.score) -
      (comparable?.previous ?? previous.value.score),
  );
  if (Math.abs(delta) < (comparable?.noiseFloor ?? current.value.noiseFloor)) {
    return { delta: null, deltaReason: "below_noise_floor" };
  }
  return { delta, deltaReason: null };
}
