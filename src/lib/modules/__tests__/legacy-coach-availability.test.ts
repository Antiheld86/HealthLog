import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { foldLegacyCoachAvailability } from "../operator-availability";

describe("foldLegacyCoachAvailability", () => {
  it("carries a pre-0343 `coach: false` into the Coach switch and drops the key", () => {
    expect(
      foldLegacyCoachAvailability({ coach: false, labs: true }, true),
    ).toEqual({
      moduleAvailabilityJson: { labs: true },
      assistantCoachEnabled: false,
    });
  });

  it("drops a `coach: true` key without switching the Coach on", () => {
    expect(foldLegacyCoachAvailability({ coach: true }, false)).toEqual({
      moduleAvailabilityJson: {},
      assistantCoachEnabled: false,
    });
  });

  it("leaves a current blob and a missing blob as they are", () => {
    expect(foldLegacyCoachAvailability({ labs: false }, true)).toEqual({
      moduleAvailabilityJson: { labs: false },
      assistantCoachEnabled: true,
    });
    expect(foldLegacyCoachAvailability(null, true)).toEqual({
      moduleAvailabilityJson: null,
      assistantCoachEnabled: true,
    });
  });
});
