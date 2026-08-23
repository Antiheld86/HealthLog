import type { Derived } from "@/lib/insights/derived/types";

import { computeActivityPillar } from "./activity";
import { computeAdiposityPillar } from "./adiposity";
import { computeBloodPressurePillar } from "./blood-pressure";
import { computeComposite } from "./composite";
import { computeGlycaemiaPillar } from "./glycaemia";
import { computeLipidsPillar } from "./lipids";
import { computeSleepPillar } from "./sleep";
import {
  SCORE_PILLAR_DOMAINS,
  SCORE_PILLAR_IDS,
  SCORE_VERSION,
  type HealthScoreReport,
  type PillarInputs,
  type ScorePillarId,
  type ScorePillarResult,
  type WeightGoalValue,
} from "./types";
import { computeWellbeingPillar } from "./wellbeing";

export interface ComputeHealthScoreInput {
  asOf: Date;
  availablePillars: ScorePillarId[];
  /**
   * Whether `availablePillars` is an authored recipe rather than the
   * account's defaults, resolved by `resolveScoreConfigured`. Rides to
   * the composite unchanged; nothing here re-derives it.
   */
  configured: boolean;
  pillars: PillarInputs;
  weightGoal: Derived<WeightGoalValue>;
  delta?: number | null;
  deltaReason?: HealthScoreReport["deltaReason"];
}

export function computeHealthScore(
  input: ComputeHealthScoreInput,
): HealthScoreReport {
  const byId: Record<ScorePillarId, ScorePillarResult> = {
    BLOOD_PRESSURE: {
      id: "BLOOD_PRESSURE",
      domain: SCORE_PILLAR_DOMAINS.BLOOD_PRESSURE,
      result: computeBloodPressurePillar(input.pillars.BLOOD_PRESSURE),
    },
    GLYCAEMIA: {
      id: "GLYCAEMIA",
      domain: SCORE_PILLAR_DOMAINS.GLYCAEMIA,
      result: computeGlycaemiaPillar(input.pillars.GLYCAEMIA),
    },
    ACTIVITY: {
      id: "ACTIVITY",
      domain: SCORE_PILLAR_DOMAINS.ACTIVITY,
      result: computeActivityPillar(input.pillars.ACTIVITY),
    },
    SLEEP: {
      id: "SLEEP",
      domain: SCORE_PILLAR_DOMAINS.SLEEP,
      result: computeSleepPillar(input.pillars.SLEEP),
    },
    ADIPOSITY: {
      id: "ADIPOSITY",
      domain: SCORE_PILLAR_DOMAINS.ADIPOSITY,
      result: computeAdiposityPillar(input.pillars.ADIPOSITY),
    },
    WELLBEING: {
      id: "WELLBEING",
      domain: SCORE_PILLAR_DOMAINS.WELLBEING,
      result: computeWellbeingPillar(input.pillars.WELLBEING),
    },
    LIPIDS: {
      id: "LIPIDS",
      domain: SCORE_PILLAR_DOMAINS.LIPIDS,
      result: computeLipidsPillar(input.pillars.LIPIDS),
    },
  };
  const available = new Set(input.availablePillars);
  const pillars = SCORE_PILLAR_IDS.filter((id) => available.has(id)).map(
    (id) => byId[id],
  );
  return {
    composite: computeComposite({
      pillars,
      availablePillars: input.availablePillars,
      asOf: input.asOf,
      configured: input.configured,
    }),
    pillars,
    delta: input.delta ?? null,
    deltaReason: input.deltaReason ?? "no_previous_window",
    scoreVersion: SCORE_VERSION,
    weightGoal: input.weightGoal,
    algorithmNotice: null,
  };
}

export type { HealthScoreReport };
export * from "./types";
