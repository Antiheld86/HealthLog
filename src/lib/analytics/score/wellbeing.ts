import type { Derived } from "@/lib/insights/derived/types";

import type { PillarValue, WellbeingPillarInput } from "./types";
import {
  clampScore,
  coverage,
  failedPillar,
  insufficientPillar,
  okPillar,
  withinWindow,
} from "./shared";

export const WELLBEING_WINDOW_DAYS = 90;

const INSTRUMENT: Record<
  "PHQ9" | "GAD7" | "WHO5",
  {
    max: number;
    low: number;
    high: number;
    source: string;
    label: string;
    itemStep: number;
  }
> = {
  PHQ9: {
    max: 27,
    low: 0,
    high: 4,
    source: "Kroenke 2001",
    label: "PHQ-9 0–4",
    itemStep: 1,
  },
  GAD7: {
    max: 21,
    low: 0,
    high: 4,
    source: "Spitzer 2006",
    label: "GAD-7 0–4",
    itemStep: 1,
  },
  WHO5: {
    max: 100,
    low: 52,
    high: 100,
    source: "WHO 1998",
    label: "WHO-5 52–100",
    // WHO-5 percentage totals move in four-point increments (raw 0–25 × 4).
    itemStep: 4,
  },
};

export function computeWellbeingPillar(
  input: WellbeingPillarInput,
): Derived<PillarValue> {
  if (input.readFailed) {
    return failedPillar({
      id: "WELLBEING",
      asOf: input.asOf,
      windowDays: WELLBEING_WINDOW_DAYS,
    });
  }

  const assessments = input.assessments
    .filter((row) => withinWindow(row.at, input.asOf, WELLBEING_WINDOW_DAYS))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const latest = assessments[0];
  if (!latest) {
    return insufficientPillar({
      id: "WELLBEING",
      source: input.source,
      asOf: input.asOf,
      windowDays: WELLBEING_WINDOW_DAYS,
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: ["completed WHO-5, PHQ-9 or GAD-7"],
      reason: input.assessments.length > 0 ? "stale" : "not_tracked",
    });
  }

  if (latest.instrument === "PHQ9" && latest.item9Flagged) {
    return insufficientPillar({
      id: "WELLBEING",
      source: input.source,
      asOf: input.asOf,
      windowDays: WELLBEING_WINDOW_DAYS,
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 1,
      missing: [],
      reason: "crisis_signposting",
    });
  }

  const spec = INSTRUMENT[latest.instrument];
  const score =
    latest.instrument === "WHO5"
      ? clampScore(latest.totalScore)
      : clampScore((1 - latest.totalScore / spec.max) * 100);
  const noiseFloor = Math.max(1, Math.round((spec.itemStep / spec.max) * 100));

  return okPillar({
    id: "WELLBEING",
    source: input.source,
    asOf: input.asOf,
    windowDays: WELLBEING_WINDOW_DAYS,
    coverage: coverage({
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 1,
    }),
    value: {
      score,
      observed: {
        value: latest.totalScore,
        unit: "score",
        label: `${latest.instrument} ${latest.totalScore}/${spec.max}`,
        asOf: latest.at.toISOString(),
        sources: ["COMPUTED"],
      },
      reference: {
        kind: "clinical-threshold",
        low: spec.low,
        high: spec.high,
        label: spec.label,
        source: spec.source,
      },
      noiseFloor,
      deltaEligible: true,
      deltaIdentity: latest.instrument,
    },
  });
}
