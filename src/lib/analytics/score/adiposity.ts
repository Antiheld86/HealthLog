import type { Derived } from "@/lib/insights/derived/types";

import type { AdiposityPillarInput, PillarValue } from "./types";
import {
  coverage,
  failedPillar,
  insufficientPillar,
  okPillar,
  scoreReferenceBand,
  withinWindow,
} from "./shared";

export const ADIPOSITY_WINDOW_DAYS = 180;
export const WAIST_TO_HEIGHT_REFERENCE_HIGH = 0.5;

export function computeAdiposityPillar(
  input: AdiposityPillarInput,
): Derived<PillarValue> {
  if (input.readFailed) {
    return failedPillar({
      id: "ADIPOSITY",
      asOf: input.asOf,
      windowDays: ADIPOSITY_WINDOW_DAYS,
    });
  }

  const rows = input.rows
    .filter((row) => withinWindow(row.at, input.asOf, ADIPOSITY_WINDOW_DAYS))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const candidate = rows
    .map((row) => {
      if (row.type === "WAIST_TO_HEIGHT") return { row, ratio: row.value };
      if (input.heightCm && input.heightCm > 0) {
        return { row, ratio: row.value / input.heightCm };
      }
      return null;
    })
    .find((entry) => entry !== null);
  const row = candidate?.row ?? null;
  const ratio = candidate?.ratio ?? null;
  const direct = row?.type === "WAIST_TO_HEIGHT";
  const freshWaist = rows.some((entry) => entry.type === "WAIST_CIRCUMFERENCE");

  if (ratio == null || row == null) {
    return insufficientPillar({
      id: "ADIPOSITY",
      source: input.source,
      asOf: input.asOf,
      windowDays: ADIPOSITY_WINDOW_DAYS,
      requiredInputs: freshWaist ? 2 : 1,
      presentInputs: freshWaist ? 1 : 0,
      historyDays: 0,
      missing:
        freshWaist && !input.heightCm ? ["height"] : ["waist measurement"],
      reason:
        freshWaist && !input.heightCm
          ? "missing_height"
          : input.rows.length > 0
            ? "stale"
            : "not_tracked",
    });
  }

  const roundedRatio = Math.round(ratio * 1000) / 1000;
  return okPillar({
    id: "ADIPOSITY",
    source: input.source,
    asOf: input.asOf,
    windowDays: ADIPOSITY_WINDOW_DAYS,
    coverage: coverage({
      requiredInputs: direct ? 1 : 2,
      presentInputs: direct ? 1 : 2,
      historyDays: 1,
    }),
    value: {
      score: scoreReferenceBand(
        roundedRatio,
        0,
        WAIST_TO_HEIGHT_REFERENCE_HIGH,
      ),
      observed: {
        value: roundedRatio,
        unit: "ratio",
        label: `waist-to-height ${roundedRatio.toFixed(3)}`,
        asOf: row.at.toISOString(),
        sources: [row.source],
      },
      reference: {
        kind: "clinical-threshold",
        low: 0,
        high: WAIST_TO_HEIGHT_REFERENCE_HIGH,
        label: `< ${WAIST_TO_HEIGHT_REFERENCE_HIGH}`,
        source: "NICE 2022",
      },
      noiseFloor: 0,
      deltaEligible: false,
      deltaIdentity: "waist_to_height",
    },
  });
}
