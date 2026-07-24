import { describe, expect, it } from "vitest";

import { pickCanonicalWorkoutRows } from "@/lib/measurements/pick-canonical-workout-rows";
import { DEFAULT_WORKOUT_SOURCE_PRIORITY } from "@/lib/sources/pick-canonical-workout";
import { DEFAULT_SOURCE_PRIORITY } from "@/lib/validations/source-priority";

/**
 * v1.32.15 — Polar rides the SAME source-agnostic workout dedup engine as every
 * other source: placing POLAR on the ladders is all that is needed for an
 * Apple-Watch + Polar twin of one run to collapse to a single canonical row.
 * No Polar-specific dedup path exists (nor should it).
 */
const D = (iso: string) => new Date(iso);

describe("POLAR workout dedup — read-time canonical picker", () => {
  it("collapses an Apple-Health + Polar twin of the same run to the device row", () => {
    const rows = [
      {
        startedAt: D("2026-07-01T06:30:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH" as const,
      },
      // Same run captured by the Polar watch a minute later — same sport, same
      // 5-minute slot.
      {
        startedAt: D("2026-07-01T06:31:00Z"),
        sportType: "running",
        source: "POLAR" as const,
      },
    ];
    const canonical = pickCanonicalWorkoutRows(rows);
    expect(canonical).toHaveLength(1);
    // Apple Health (phone-aggregated) outranks Polar in the steps ladder.
    expect(canonical[0].source).toBe("APPLE_HEALTH");
  });

  it("keeps a Polar-only run (no competing source) untouched", () => {
    const rows = [
      {
        startedAt: D("2026-07-02T18:00:00Z"),
        sportType: "cycling",
        source: "POLAR" as const,
      },
    ];
    const canonical = pickCanonicalWorkoutRows(rows);
    expect(canonical).toHaveLength(1);
    expect(canonical[0].source).toBe("POLAR");
  });

  it("ranks POLAR above STRAVA when both cover the same workout", () => {
    const rows = [
      {
        startedAt: D("2026-07-03T07:00:30Z"),
        sportType: "running",
        source: "STRAVA" as const,
      },
      {
        startedAt: D("2026-07-03T07:00:00Z"),
        sportType: "running",
        source: "POLAR" as const,
      },
    ];
    const canonical = pickCanonicalWorkoutRows(rows);
    expect(canonical).toHaveLength(1);
    // Polar is a device-native HR capture; Strava is often a re-upload.
    expect(canonical[0].source).toBe("POLAR");
  });
});

describe("POLAR sits in the workout source ladders", () => {
  it("is present in the workout default ladder, below WITHINGS, above STRAVA", () => {
    const polar = DEFAULT_WORKOUT_SOURCE_PRIORITY.indexOf("POLAR");
    const withings = DEFAULT_WORKOUT_SOURCE_PRIORITY.indexOf("WITHINGS");
    const strava = DEFAULT_WORKOUT_SOURCE_PRIORITY.indexOf("STRAVA");
    expect(polar).toBeGreaterThan(withings);
    expect(polar).toBeLessThan(strava);
  });

  it("is present in the `steps` ladder the read picker resolves against, above STRAVA", () => {
    const steps = DEFAULT_SOURCE_PRIORITY.steps;
    const polar = steps.indexOf("POLAR");
    const apple = steps.indexOf("APPLE_HEALTH");
    const strava = steps.indexOf("STRAVA");
    expect(polar).toBeGreaterThan(apple);
    expect(polar).toBeLessThan(strava);
  });
});
