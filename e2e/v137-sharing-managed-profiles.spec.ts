import { expect, test } from "./setup/test";

import { RELEASE_JOURNEYS } from "../tests/fixtures/v137/e2e-journeys";

test.describe("sharing release journey anchors", () => {
  for (const journey of RELEASE_JOURNEYS) {
    test(`anchor: ${journey.name}`, () => {
      expect(journey.contract).toBe("inventory-only");
    });
  }

  test("adult levels and lifecycle", () => {
    const adultJourneyNames = RELEASE_JOURNEYS.filter((journey) =>
      [
        "adult-full-read-scoped-read-write-and-manage",
        "manage-mutation-activity-and-fenced-settings",
      ].includes(journey.name),
    ).map((journey) => journey.name);

    expect(adultJourneyNames).toEqual([
      "adult-full-read-scoped-read-write-and-manage",
      "manage-mutation-activity-and-fenced-settings",
    ]);
  });
});
