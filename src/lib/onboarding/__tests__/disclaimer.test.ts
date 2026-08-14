/**
 * The disclaimer-version gate (welcome step 0).
 *
 * Watched red: with `isDisclaimerAcknowledgmentCurrent` reduced to the
 * pre-fix timestamp-only check (`acknowledgedAt != null`) the stale-version
 * case below fails — the version column was written on acknowledgment but
 * never compared, so bumping `DISCLAIMER_VERSION` could not re-prompt.
 */
import { describe, expect, it } from "vitest";

import {
  DISCLAIMER_VERSION,
  isDisclaimerAcknowledgmentCurrent,
} from "../disclaimer";

describe("isDisclaimerAcknowledgmentCurrent", () => {
  it("holds for an acknowledgment of the current version", () => {
    expect(
      isDisclaimerAcknowledgmentCurrent(
        "2026-06-20T08:00:00.000Z",
        DISCLAIMER_VERSION,
      ),
    ).toBe(true);
  });

  it("re-prompts when the stored acknowledgment is for an older version", () => {
    expect(
      isDisclaimerAcknowledgmentCurrent(
        "2026-06-20T08:00:00.000Z",
        "2025-01-01",
      ),
    ).toBe(false);
  });

  it("re-prompts when the version was never recorded", () => {
    expect(
      isDisclaimerAcknowledgmentCurrent("2026-06-20T08:00:00.000Z", null),
    ).toBe(false);
  });

  it("requires an acknowledgment timestamp at all", () => {
    expect(isDisclaimerAcknowledgmentCurrent(null, DISCLAIMER_VERSION)).toBe(
      false,
    );
    expect(isDisclaimerAcknowledgmentCurrent(undefined, undefined)).toBe(false);
  });
});
