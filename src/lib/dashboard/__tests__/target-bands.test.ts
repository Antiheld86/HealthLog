/**
 * v1.18.6 — parity test for the server-side band / target math
 * (audit finding #3). `buildTargetBands` must produce byte-identical
 * numbers to the legacy client-side derivation in `page.tsx`, which is
 * just a sequence of the SAME pure helpers. The test re-derives each
 * structure with those helpers and asserts deep equality for a male
 * profile, a female profile, and a no-profile user.
 */
import { describe, it, expect } from "vitest";

import { buildTargetBands } from "../snapshot";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import {
  buildTrafficLightBands,
  buildTrafficRange,
  buildWeightBandsFromHeight,
  buildWeightRangeFromHeight,
  getBodyFatTargetRange,
} from "@/lib/analytics/value-bands";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";

/** Re-derive bands exactly as `page.tsx` did before v1.18.6. */
function clientBands(profile: {
  dateOfBirth: Date | null;
  gender: "MALE" | "FEMALE" | null;
  heightCm: number | null;
}) {
  const bpTargets = profile.dateOfBirth
    ? getBpTargets(profile.dateOfBirth)
    : null;
  const pulseAge = getAgeFromDateOfBirth(profile.dateOfBirth);
  const pulseTarget = getPersonalizedPulseTarget(pulseAge, profile.gender);
  const bodyFatRange = getBodyFatTargetRange(profile.gender);
  const weightRange = profile.heightCm
    ? buildWeightRangeFromHeight(profile.heightCm)
    : null;
  const weightBands = profile.heightCm
    ? buildWeightBandsFromHeight(profile.heightCm, {
        lowerBound: 30,
        upperBound: 250,
      })
    : null;
  return {
    bpTargets,
    bpSysRange: bpTargets
      ? buildTrafficRange(bpTargets.sysLow, bpTargets.sysHigh)
      : null,
    bpDiaRange: bpTargets
      ? buildTrafficRange(bpTargets.diaLow, bpTargets.diaHigh)
      : null,
    pulseDisplayRange: {
      greenMin: pulseTarget.greenMin,
      greenMax: pulseTarget.greenMax,
      orangeMin: pulseTarget.orangeMin,
      orangeMax: pulseTarget.orangeMax,
    },
    pulseBands: [
      {
        min: 30,
        max: pulseTarget.orangeMin,
        color: "var(--destructive)",
        opacity: 0.16,
      },
      {
        min: pulseTarget.orangeMin,
        max: pulseTarget.greenMin,
        color: "var(--warning)",
        opacity: 0.18,
      },
      {
        min: pulseTarget.greenMin,
        max: pulseTarget.greenMax,
        color: "var(--success)",
        opacity: 0.2,
      },
      {
        min: pulseTarget.greenMax,
        max: pulseTarget.orangeMax,
        color: "var(--warning)",
        opacity: 0.18,
      },
      {
        min: pulseTarget.orangeMax,
        max: 220,
        color: "var(--destructive)",
        opacity: 0.16,
      },
    ].filter((b) => b.max > b.min),
    bodyFatRange,
    bodyFatBands: buildTrafficLightBands(bodyFatRange.min, bodyFatRange.max, {
      lowerBound: 2,
      upperBound: 55,
    }),
    weightRange,
    weightBands,
  };
}

describe("buildTargetBands — server/client parity", () => {
  const profiles: Array<{
    name: string;
    dateOfBirth: Date | null;
    gender: "MALE" | "FEMALE" | null;
    heightCm: number | null;
  }> = [
    {
      name: "male 180cm with DOB",
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
      gender: "MALE",
      heightCm: 180,
    },
    {
      name: "female 165cm with DOB",
      dateOfBirth: new Date("1970-01-01T00:00:00.000Z"),
      gender: "FEMALE",
      heightCm: 165,
    },
    {
      name: "no-profile user (null DOB / gender / height)",
      dateOfBirth: null,
      gender: null,
      heightCm: null,
    },
  ];

  for (const profile of profiles) {
    it(`matches the legacy client math for ${profile.name}`, () => {
      const server = buildTargetBands(profile);
      const client = clientBands(profile);
      expect(server).toEqual(client);
    });
  }

  it("gives OTHER the neutral bands, identical to an unanswered profile", () => {
    // OTHER has no row in the percentile / body-fat tables. It must land on
    // the same neutral fallback an unanswered profile gets, never on one of
    // the two sides — and the type must be able to carry it here at all.
    const other = buildTargetBands({
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
      gender: "OTHER",
      heightCm: 180,
    });
    const unanswered = buildTargetBands({
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
      gender: null,
      heightCm: 180,
    });
    expect(other).toEqual(unanswered);
    const male = buildTargetBands({
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
      gender: "MALE",
      heightCm: 180,
    });
    expect(other.bodyFatBands).not.toEqual(male.bodyFatBands);
  });

  it("nulls the profile-derived bands when no DOB / height", () => {
    const bands = buildTargetBands({
      dateOfBirth: null,
      gender: null,
      heightCm: null,
    });
    expect(bands.bpTargets).toBeNull();
    expect(bands.bpSysRange).toBeNull();
    expect(bands.bpDiaRange).toBeNull();
    expect(bands.weightRange).toBeNull();
    expect(bands.weightBands).toBeNull();
    // Pulse + body-fat always resolve (AHA / neutral fallback).
    expect(bands.pulseBands.length).toBeGreaterThan(0);
    expect(bands.bodyFatBands.length).toBeGreaterThan(0);
  });
});
