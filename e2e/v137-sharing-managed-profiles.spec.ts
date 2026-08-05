import { expect, test } from "@playwright/test";

import { RELEASE_JOURNEYS } from "../tests/fixtures/v137/e2e-journeys";

test.describe("sharing release journey anchors", () => {
  for (const journey of RELEASE_JOURNEYS) {
    test(`anchor: ${journey.name}`, () => {
      expect(journey.contract).toBe("inventory-only");
    });
  }
});
