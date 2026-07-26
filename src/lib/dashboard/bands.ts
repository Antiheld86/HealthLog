/**
 * Dashboard band / target math — the single source of truth.
 *
 * Pure projection over a user's profile facts (DOB / gender / height):
 * no DB read, no clock, no network, no `server-only` dep. Every building
 * block it composes (`@/lib/analytics/{value-bands,bp-targets,pulse-targets}`)
 * is itself client-safe, so this leaf imports cleanly into both the
 * server-side snapshot builder (`@/lib/dashboard/snapshot`) and the
 * `"use client"` dashboard page fallback (`src/app/page.tsx`).
 *
 * Before v1.18.6 the band construction lived inline in two places — the
 * snapshot builder and the page's snapshot-disabled fallback — so a
 * threshold change had to be mirrored by hand or the two surfaces would
 * grade the same metric differently. Both now call `buildDashboardBands`,
 * so the band/target math lives in exactly one place. `buildTargetBands`
 * is kept as an alias for the snapshot-era import sites.
 */
import { getBpTargets, type BpTargets } from "@/lib/analytics/bp-targets";
import {
  buildTrafficLightBands,
  buildTrafficRange,
  buildWeightBandsFromHeight,
  buildWeightRangeFromHeight,
  getBodyFatTargetRange,
  type ValueBand,
  type TrafficRange,
} from "@/lib/analytics/value-bands";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";
import { binaryReferenceSex, type ProfileSex } from "@/lib/profile/sex";

export interface DashboardTargetBands {
  /** Personalised BP target numbers (null when no DOB). */
  bpTargets: BpTargets | null;
  /** Systolic traffic range (null when no DOB). */
  bpSysRange: TrafficRange | null;
  /** Diastolic traffic range (null when no DOB). */
  bpDiaRange: TrafficRange | null;
  /** Resting-pulse display range (always present — AHA fallback). */
  pulseDisplayRange: {
    greenMin: number;
    greenMax: number;
    orangeMin: number;
    orangeMax: number;
  };
  /** Resting-pulse chart bands (always present — AHA fallback). */
  pulseBands: ValueBand[];
  /** Body-fat target range (gender-aware; always present). */
  bodyFatRange: { min: number; max: number };
  /** Body-fat chart bands (always present). */
  bodyFatBands: ValueBand[];
  /** Weight traffic range (null when no height). */
  weightRange: TrafficRange | null;
  /** Weight chart bands (null when no height). */
  weightBands: ValueBand[] | null;
}

/**
 * Resolve the band / target math from a user's profile facts. Pure; no
 * DB read. The snapshot builder and the page fallback both call this so
 * they produce byte-identical numbers.
 */
export function buildDashboardBands(profile: {
  dateOfBirth: Date | null;
  gender: ProfileSex;
  heightCm: number | null;
}): DashboardTargetBands {
  const bpTargets = profile.dateOfBirth
    ? getBpTargets(profile.dateOfBirth)
    : null;
  const pulseAge = getAgeFromDateOfBirth(profile.dateOfBirth);
  // The percentile and body-fat tables carry two sexes and no third row;
  // both helpers answer a null with a neutral midpoint rather than a side.
  const referenceSex = binaryReferenceSex(profile.gender);
  const pulseTarget = getPersonalizedPulseTarget(pulseAge, referenceSex);
  const bodyFatRange = getBodyFatTargetRange(referenceSex);
  const weightRange = profile.heightCm
    ? buildWeightRangeFromHeight(profile.heightCm)
    : null;
  const weightBands = profile.heightCm
    ? buildWeightBandsFromHeight(profile.heightCm, {
        lowerBound: 30,
        upperBound: 250,
      })
    : null;
  const bpSysRange = bpTargets
    ? buildTrafficRange(bpTargets.sysLow, bpTargets.sysHigh)
    : null;
  const bpDiaRange = bpTargets
    ? buildTrafficRange(bpTargets.diaLow, bpTargets.diaHigh)
    : null;
  const pulseBands = [
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
  ].filter((band) => band.max > band.min);
  const bodyFatBands = buildTrafficLightBands(
    bodyFatRange.min,
    bodyFatRange.max,
    {
      lowerBound: 2,
      upperBound: 55,
    },
  );
  return {
    bpTargets,
    bpSysRange,
    bpDiaRange,
    pulseDisplayRange: {
      greenMin: pulseTarget.greenMin,
      greenMax: pulseTarget.greenMax,
      orangeMin: pulseTarget.orangeMin,
      orangeMax: pulseTarget.orangeMax,
    },
    pulseBands,
    bodyFatRange,
    bodyFatBands,
    weightRange,
    weightBands,
  };
}

// The snapshot builder re-exports `buildDashboardBands` under the historic
// `buildTargetBands` name (see dashboard/snapshot.ts) so callers and the
// parity test keep working without a duplicate export living in this file.
