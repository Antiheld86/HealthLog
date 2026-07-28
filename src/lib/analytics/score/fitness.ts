import { lookupNormalRange } from "@/lib/insights/derived/norms";
import type { Derived } from "@/lib/insights/derived/types";

import type { FitnessPillarInput, PillarValue } from "./types";
import {
  coverage,
  failedPillar,
  insufficientPillar,
  okPillar,
  scoreReferenceBand,
  withinWindow,
} from "./shared";

export const FITNESS_WINDOW_DAYS = 365;

export function computeFitnessPillar(
  input: FitnessPillarInput,
): Derived<PillarValue> {
  if (input.readFailed) {
    return failedPillar({
      id: "FITNESS",
      asOf: input.asOf,
      windowDays: FITNESS_WINDOW_DAYS,
    });
  }

  const norm = lookupNormalRange("VO2_MAX", input.ageYears, input.sex);
  if (!norm) {
    return insufficientPillar({
      id: "FITNESS",
      source: input.source,
      asOf: input.asOf,
      windowDays: FITNESS_WINDOW_DAYS,
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: ["age and binary reference sex"],
      reason: "missing_reference_profile",
    });
  }

  const measured = input.rows
    .filter(
      (row) =>
        row.measured && withinWindow(row.at, input.asOf, FITNESS_WINDOW_DAYS),
    )
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const latest = measured[0];
  if (!latest) {
    return insufficientPillar({
      id: "FITNESS",
      source: input.source,
      asOf: input.asOf,
      windowDays: FITNESS_WINDOW_DAYS,
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: ["measured VO₂max test"],
      reason: input.rows.length > 0 ? "unverified_or_stale" : "not_tracked",
    });
  }

  return okPillar({
    id: "FITNESS",
    source: input.source,
    asOf: input.asOf,
    windowDays: FITNESS_WINDOW_DAYS,
    coverage: coverage({
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 1,
    }),
    value: {
      score: scoreReferenceBand(latest.value, norm.low, null),
      observed: {
        value: latest.value,
        unit: "mL/(kg·min)",
        label: `${latest.value} mL/(kg·min) measured`,
        asOf: latest.at.toISOString(),
        sources: [latest.source],
      },
      reference: {
        kind: "population-percentile",
        low: norm.low,
        high: norm.high,
        label: `${norm.low}–${norm.high} mL/(kg·min) age/sex band`,
        source: "FRIEND (Kaminsky 2015)",
      },
      noiseFloor: 0,
      deltaEligible: false,
      deltaIdentity: "measured_vo2max",
    },
  });
}
