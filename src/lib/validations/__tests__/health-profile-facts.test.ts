import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  HEALTH_PROFILE_AI_SECTIONS,
  removedHealthProfileFactSchema,
} from "../health-profile-facts";

describe("health profile AI inclusion defaults", () => {
  it("keeps the legacy opt-in list independent from accepted section values", () => {
    expect(DEFAULT_HEALTH_PROFILE_AI_SECTIONS).not.toBe(
      HEALTH_PROFILE_AI_SECTIONS,
    );
    expect(DEFAULT_HEALTH_PROFILE_AI_SECTIONS).toEqual([
      "ABOUT_ME",
      "CONDITIONS",
      "ALLERGIES",
      "COACH_FOCUS",
      "FAMILY_HISTORY",
      "SMOKING_STATUS",
      "ALCOHOL_PATTERN",
      "SHIFT_SCHEDULE",
    ]);
  });
});

describe("health profile fact removal response", () => {
  it("contains only revision metadata and a valid removal instant", () => {
    expect(
      removedHealthProfileFactSchema.parse({
        id: "fact-1",
        kind: "SMOKING_STATUS",
        removedAt: "2026-07-28T12:00:00.000Z",
        value: "FORMER",
      }),
    ).toEqual({
      id: "fact-1",
      kind: "SMOKING_STATUS",
      removedAt: "2026-07-28T12:00:00.000Z",
    });
    expect(
      removedHealthProfileFactSchema.safeParse({
        id: "fact-1",
        kind: "SMOKING_STATUS",
        removedAt: "not-a-date",
      }).success,
    ).toBe(false);
  });
});
