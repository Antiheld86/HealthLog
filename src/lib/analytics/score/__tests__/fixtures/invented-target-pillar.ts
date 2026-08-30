/**
 * The shape the guard beside this file exists to reject, kept alive as a
 * fixture so the guard can be shown failing against it.
 *
 * This is the weight pillar as it scored before v1.34: the band came from
 * `22 × height²` in metres, widened by 2 kg either side, and a person with
 * a height on file was graded against it whether or not they had ever set
 * a target. The band was the only producer of that pillar's verdict, no
 * surface named it, and the target the person HAD entered sat unread. The
 * commit that removed it ("grade weight against the user's own target,
 * never a fabricated one") deleted `defaultWeightTargetFromHeight`; the
 * arithmetic below is that function plus the ±2 kg expansion it fed.
 *
 * Written in today's `PillarValue` shape rather than the old one, because
 * a guard can only reject what it can read, and the point of the fixture
 * is to prove the guard rejects this CLASS — not to preserve a dead type.
 * Deliberately given a plausible citation string rather than an empty one:
 * a check that only catches the laziest version of the mistake catches
 * almost nothing.
 *
 * Nothing in `src/` imports this. It exists for the guard.
 */
import type { PillarReference, PillarValue } from "../../types";

export interface InventedTargetInput {
  /** The profile field the band is synthesised from. */
  heightCm: number | null;
  /** Most recent weight in kg. */
  weightKg: number;
  at: Date;
}

/** `defaultWeightTargetFromHeight`, restored verbatim from the diff. */
function defaultWeightTargetFromHeight(heightCm: number | null): number | null {
  if (heightCm === null || heightCm <= 0) return null;
  const heightM = heightCm / 100;
  return Math.round(22 * heightM * heightM * 10) / 10;
}

/**
 * Grade a weight against the fabricated band. Returns `null` when there
 * is no height to invent from, which is exactly how the original behaved
 * — and exactly why the defect was invisible to anyone testing an account
 * with no height on file.
 */
export function computeInventedTargetPillar(
  input: InventedTargetInput,
): PillarValue | null {
  const target = defaultWeightTargetFromHeight(input.heightCm);
  if (target === null) return null;

  const low = Math.round((target - 2) * 10) / 10;
  const high = Math.round((target + 2) * 10) / 10;
  const inside = input.weightKg >= low && input.weightKg <= high;

  const reference: PillarReference = {
    kind: "clinical-threshold",
    low,
    high,
    label: `${low}–${high} kg`,
    source: "BMI 22 target for your height",
  };

  return {
    score: inside ? 100 : 60,
    observed: {
      value: input.weightKg,
      unit: "kg",
      label: `${input.weightKg} kg`,
      asOf: input.at.toISOString(),
      sources: ["MANUAL"],
    },
    reference,
    noiseFloor: 1,
    deltaEligible: true,
    deltaIdentity: "invented_weight_target",
  };
}
