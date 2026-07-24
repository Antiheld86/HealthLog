import { describe, expect, it } from "vitest";

import {
  POLAR_SPORT_TABLE,
  mapPolarSportType,
  normalisePolarSportKey,
} from "../sport-map";
import { workoutSportTypeEnum } from "@/lib/validations/workout";

describe("POLAR_SPORT_TABLE", () => {
  it("maps every table entry into a canonical WorkoutSportType", () => {
    const valid = new Set(workoutSportTypeEnum.options as readonly string[]);
    for (const row of POLAR_SPORT_TABLE) {
      expect(valid.has(row.canonical)).toBe(true);
    }
  });

  it("has no duplicate normalised keys", () => {
    const keys = POLAR_SPORT_TABLE.map((r) => normalisePolarSportKey(r.name));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("mapPolarSportType", () => {
  it("prefers detailed_sport_info over the coarse sport", () => {
    // Coarse says cycling, detailed says trail running — detailed wins.
    expect(mapPolarSportType("TRAIL_RUNNING", "CYCLING")).toBe("running");
  });

  it("falls back to the coarse sport when detailed is absent", () => {
    expect(mapPolarSportType(null, "CYCLING")).toBe("cycling");
    expect(mapPolarSportType(undefined, "SWIMMING")).toBe("swimming");
    expect(mapPolarSportType("", "STRENGTH_TRAINING")).toBe("strength");
  });

  it("falls back to the coarse sport when detailed is unrecognised", () => {
    // An unknown granular value still gets a chance at the coarse mapping.
    expect(mapPolarSportType("SOME_NEW_POLAR_SPORT", "RUNNING")).toBe(
      "running",
    );
  });

  it("defaults to other for an unknown pair", () => {
    expect(mapPolarSportType("NOPE", "ALSO_NOPE")).toBe("other");
    expect(mapPolarSportType(null, null)).toBe("other");
    expect(mapPolarSportType(undefined, undefined)).toBe("other");
  });

  it("applies the documented bucket judgment calls consistently with Strava", () => {
    // Paddle → rowing, racket → tennis, functional/climbing → crossTraining,
    // mobility → mindAndBody, e-bike → cycling, snow → other.
    expect(mapPolarSportType("KAYAKING", null)).toBe("rowing");
    expect(mapPolarSportType("PADEL", null)).toBe("tennis");
    expect(mapPolarSportType("FUNCTIONAL_TRAINING", null)).toBe(
      "crossTraining",
    );
    expect(mapPolarSportType("CLIMBING", null)).toBe("crossTraining");
    expect(mapPolarSportType("PILATES", null)).toBe("mindAndBody");
    expect(mapPolarSportType("E_BIKE", null)).toBe("cycling");
    expect(mapPolarSportType("ALPINE_SKIING", null)).toBe("other");
  });

  it("is resilient to casing / separator variants", () => {
    expect(mapPolarSportType("trail running", null)).toBe("running");
    expect(mapPolarSportType("Trail-Running", null)).toBe("running");
  });
});
