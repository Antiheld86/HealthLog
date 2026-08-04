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
  buildBandsFromTrafficRange,
  buildTrafficLightBands,
  buildTrafficRange,
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
import { getEffectiveRange } from "@/lib/analytics/effective-range";

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
  /**
   * Weight traffic range — the user's own target band when they set one,
   * else the height-derived WHO band, else null (no height, no target).
   */
  weightRange: TrafficRange | null;
  /** Weight chart bands, from the same range. Null when the range is null. */
  weightBands: ValueBand[] | null;
}

/**
 * Resolve the band / target math from a user's profile facts. Pure; no
 * DB read. The snapshot builder and the page fallback both call this so
 * they produce byte-identical numbers.
 *
 * v1.34 — `weightTargetOverride` is the user's OWN weight band as stored in
 * `User.thresholdsJson.WEIGHT`, in kg. When present it replaces the
 * height-derived WHO band on both the weight range and the weight chart bands:
 * a user who has answered "this is my target" must not keep reading a shaded
 * zone that ignores the answer. `null` keeps the height-derived band. Required
 * rather than optional so every call site is named by the compiler.
 */
export function buildDashboardBands(profile: {
  dateOfBirth: Date | null;
  gender: ProfileSex;
  heightCm: number | null;
  weightTargetOverride: { min: number; max: number } | null;
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
  // v1.34 — an explicit target outranks the height-derived WHO band. Without
  // this the dashboard kept shading a band the user had already answered, and
  // the answer lived on `/targets` where nothing else could see it. The
  // override is routed through `getEffectiveRange` rather than widened here,
  // so the orange wings match the `/targets` page and the doctor report
  // exactly instead of inventing a second convention. No height and no target
  // → no band at all, unchanged.
  const weightRange = profile.weightTargetOverride
    ? getEffectiveRange(
        "WEIGHT",
        {
          heightCm: profile.heightCm,
          dateOfBirth: profile.dateOfBirth,
          gender: profile.gender,
        },
        { WEIGHT: profile.weightTargetOverride },
      ).range
    : profile.heightCm
      ? buildWeightRangeFromHeight(profile.heightCm)
      : null;
  const weightBands = weightRange
    ? buildBandsFromTrafficRange(weightRange, {
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

/** The profile facts `buildDashboardBands` derives a band from. */
export interface BandProfile {
  dateOfBirth: Date | null;
  gender: ProfileSex;
  heightCm: number | null;
  weightTargetOverride: { min: number; max: number } | null;
}

/**
 * Which profile the dashboard's CLIENT-side band fallback may compute from.
 *
 * The fallback exists because the server-resolved bands arrive with the
 * snapshot and the charts have to draw before that: it recomputes the same
 * numbers from the profile the page already holds. That profile comes from
 * `/api/auth/me`, which is an actor surface — it answers about the person
 * logged in and deliberately never about the record they are acting on. So
 * while a switch is active it describes the DELEGATE, and drawing a band from
 * it puts one person's reference ranges over another person's readings: a
 * thirty-year-old helper's blood-pressure target shading an eighty-year-old's
 * chart, which looks like a reading and is not one.
 *
 * Under a switch this therefore answers with nothing. The charts render
 * unshaded until the snapshot's own bands land, and unshaded is honest —
 * an absent band says nothing, while a borrowed one says something false.
 *
 * A pure function rather than three ternaries at the call site, because this
 * is the whole of the decision and it should be possible to state it, test it,
 * and break it in one place.
 */
export function viewerBandProfile(
  profile: BandProfile,
  inSharedRecord: boolean,
): BandProfile {
  if (!inSharedRecord) return profile;
  return {
    dateOfBirth: null,
    gender: null,
    heightCm: null,
    weightTargetOverride: null,
  };
}
