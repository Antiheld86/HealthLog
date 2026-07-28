import type { Derived } from "@/lib/insights/derived/types";

import { computeActivityPillar } from "./activity";
import { computeAdiposityPillar } from "./adiposity";
import { computeBloodPressurePillar } from "./blood-pressure";
import { computeComposite } from "./composite";
import { computeFitnessPillar } from "./fitness";
import { computeGlycaemiaPillar } from "./glycaemia";
import { computeLipidsPillar } from "./lipids";
import { computeSleepPillar } from "./sleep";
import {
  SCORE_PILLAR_IDS,
  SCORE_VERSION,
  type CompositeValue,
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
      domain: "cardiometabolic",
      result: computeBloodPressurePillar(input.pillars.BLOOD_PRESSURE),
    },
    GLYCAEMIA: {
      id: "GLYCAEMIA",
      domain: "cardiometabolic",
      result: computeGlycaemiaPillar(input.pillars.GLYCAEMIA),
    },
    ACTIVITY: {
      id: "ACTIVITY",
      domain: "activity",
      result: computeActivityPillar(input.pillars.ACTIVITY),
    },
    SLEEP: {
      id: "SLEEP",
      domain: "sleep",
      result: computeSleepPillar(input.pillars.SLEEP),
    },
    ADIPOSITY: {
      id: "ADIPOSITY",
      domain: "adiposity",
      result: computeAdiposityPillar(input.pillars.ADIPOSITY),
    },
    WELLBEING: {
      id: "WELLBEING",
      domain: "wellbeing",
      result: computeWellbeingPillar(input.pillars.WELLBEING),
    },
    FITNESS: {
      id: "FITNESS",
      domain: "fitness",
      result: computeFitnessPillar(input.pillars.FITNESS),
    },
    LIPIDS: {
      id: "LIPIDS",
      domain: "cardiometabolic",
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
    }),
    pillars,
    delta: input.delta ?? null,
    deltaReason: input.deltaReason ?? "no_previous_window",
    scoreVersion: SCORE_VERSION,
    weightGoal: input.weightGoal,
    algorithmNotice: null,
  };
}

export type { CompositeValue, HealthScoreReport };
export * from "./types";
