import { expect, test } from "./setup/test";

import { ACCESSIBILITY_STATES } from "../tests/fixtures/v137/e2e-journeys";

test.describe("sharing accessibility anchors", () => {
  for (const state of ACCESSIBILITY_STATES) {
    test(`anchor: ${state.name}`, () => {
      expect(state.contract).toBe("inventory-only");
    });
  }
});
