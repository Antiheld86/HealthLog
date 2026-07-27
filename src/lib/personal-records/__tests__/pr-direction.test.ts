import { describe, expect, it } from "vitest";
import {
  getPRDirection,
  isPRTrackable,
  resolveWeightGoalDirection,
  type PRDirectionContext,
} from "../pr-direction";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import {
  PersonalRecordDirection,
  type MeasurementType,
} from "@/generated/prisma/client";

/**
 * v1.34 — the resolver takes the user-goal context. `NO_GOAL` is the account
 * with no weight target on file, which is the historical behaviour every
 * assertion below was written against.
 */
const NO_GOAL: PRDirectionContext = { weightGoal: null };

describe("getPRDirection", () => {
  // Drift guard — every canonical MeasurementType MUST land in exactly
  // one branch of the switch so the future detection worker never
  // encounters an "I have a sample but no direction" race.
  it("returns either MAX, MIN, or null for every MeasurementType", () => {
    for (const type of measurementTypeEnum.options) {
      const result = getPRDirection(type as MeasurementType, NO_GOAL);
      expect(
        result === null ||
          result === PersonalRecordDirection.MAX ||
          result === PersonalRecordDirection.MIN,
        `getPRDirection(${type}) returned ${result}`,
      ).toBe(true);
    }
  });

  it("returns MAX for the activity + daylight + 'higher is better' metrics", () => {
    const maxMetrics: MeasurementType[] = [
      "ACTIVITY_STEPS",
      "ACTIVE_ENERGY_BURNED",
      "FLIGHTS_CLIMBED",
      "WALKING_RUNNING_DISTANCE",
      "VO2_MAX",
      "HEART_RATE_VARIABILITY",
      "TOTAL_BODY_WATER",
      "BONE_MASS",
      "MUSCLE_MASS",
      "TIME_IN_DAYLIGHT",
    ];
    for (const t of maxMetrics) {
      expect(getPRDirection(t, NO_GOAL)).toBe(PersonalRecordDirection.MAX);
    }
  });

  it("returns MIN for resting HR + composition + cardiovascular-risk + audio", () => {
    const minMetrics: MeasurementType[] = [
      "RESTING_HEART_RATE",
      "BODY_FAT",
      "FAT_MASS",
      "VISCERAL_FAT",
      "VASCULAR_AGE",
      "PULSE_WAVE_VELOCITY",
      "AUDIO_EXPOSURE_ENV",
      "AUDIO_EXPOSURE_HEADPHONE",
    ];
    for (const t of minMetrics) {
      expect(getPRDirection(t, NO_GOAL)).toBe(PersonalRecordDirection.MIN);
    }
  });

  it("returns null for BP, glucose, sleep, and homeostatic vitals", () => {
    const noPRMetrics: MeasurementType[] = [
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "BLOOD_GLUCOSE",
      "BODY_TEMPERATURE",
      "SKIN_TEMPERATURE",
      "PULSE",
      "OXYGEN_SATURATION",
      "WEIGHT",
      "SLEEP_DURATION",
      "FAT_FREE_MASS",
    ];
    for (const t of noPRMetrics) {
      expect(getPRDirection(t, NO_GOAL)).toBeNull();
    }
  });
});

describe("isPRTrackable", () => {
  it("returns true exactly when getPRDirection is non-null", () => {
    for (const type of measurementTypeEnum.options) {
      const t = type as MeasurementType;
      expect(isPRTrackable(t, NO_GOAL)).toBe(
        getPRDirection(t, NO_GOAL) !== null,
      );
    }
  });
});

/**
 * v1.34 — weight + BMI stopped deferring on `User.thresholdsJson`. With no
 * target they answer `null` exactly as they have since v1.5.5; with one they
 * answer the direction the user's own goal points in.
 */
describe("getPRDirection — user weight goal", () => {
  const goalMetrics: MeasurementType[] = ["WEIGHT", "BODY_MASS_INDEX"];

  it("stays null when no weight target is set", () => {
    for (const t of goalMetrics) {
      expect(getPRDirection(t, { weightGoal: null })).toBeNull();
      expect(isPRTrackable(t, { weightGoal: null })).toBe(false);
    }
  });

  it("reads MIN when the user is working down toward their target", () => {
    for (const t of goalMetrics) {
      expect(getPRDirection(t, { weightGoal: "lower" })).toBe(
        PersonalRecordDirection.MIN,
      );
    }
  });

  it("reads MAX when the user is working up toward their target", () => {
    for (const t of goalMetrics) {
      expect(getPRDirection(t, { weightGoal: "higher" })).toBe(
        PersonalRecordDirection.MAX,
      );
    }
  });

  it("leaves every other metric untouched by the goal context", () => {
    for (const type of measurementTypeEnum.options) {
      const t = type as MeasurementType;
      if (goalMetrics.includes(t)) continue;
      expect(getPRDirection(t, { weightGoal: "lower" })).toBe(
        getPRDirection(t, { weightGoal: null }),
      );
    }
  });
});

describe("resolveWeightGoalDirection", () => {
  const band = { min: 70, max: 75 };

  it("returns null without a target — a goal is never inferred", () => {
    expect(resolveWeightGoalDirection(null, 90)).toBeNull();
  });

  it("returns null without a reading to place against the band", () => {
    expect(resolveWeightGoalDirection(band, null)).toBeNull();
  });

  it("returns null inside the band — the goal is already met", () => {
    expect(resolveWeightGoalDirection(band, 70)).toBeNull();
    expect(resolveWeightGoalDirection(band, 72.5)).toBeNull();
    expect(resolveWeightGoalDirection(band, 75)).toBeNull();
  });

  it("points down above the band and up below it", () => {
    expect(resolveWeightGoalDirection(band, 82)).toBe("lower");
    expect(resolveWeightGoalDirection(band, 64)).toBe("higher");
  });
});
