import { describe, expect, it } from "vitest";

import { shouldProbeOcrCapability } from "../use-ocr-extract";

describe("shouldProbeOcrCapability", () => {
  it("runs the owner-only capability probe only when the scan control can render", () => {
    const ownerControl = {
      isAuthenticated: true,
      isLoading: false,
      labsEnabled: true,
      mounted: true,
      ownRecord: true,
      labsOcr: { available: true, reason: null, onDeviceAllowed: true },
    } as const;

    expect(shouldProbeOcrCapability(ownerControl)).toBe(true);
    expect(
      shouldProbeOcrCapability({ ...ownerControl, isAuthenticated: false }),
    ).toBe(false);
    expect(
      shouldProbeOcrCapability({ ...ownerControl, ownRecord: false }),
    ).toBe(false);
    expect(
      shouldProbeOcrCapability({ ...ownerControl, labsEnabled: false }),
    ).toBe(false);
    expect(shouldProbeOcrCapability({ ...ownerControl, mounted: false })).toBe(
      false,
    );
  });

  it("follows the labsOcr capability: probes when available or when only consent is missing", () => {
    const base = {
      isAuthenticated: true,
      isLoading: false,
      labsEnabled: true,
      mounted: true,
      ownRecord: true,
    };
    const state = (reason: string | null) =>
      ({
        available: reason === null,
        reason,
        onDeviceAllowed: false,
      }) as Parameters<typeof shouldProbeOcrCapability>[0]["labsOcr"];

    // Consent is asked for inside the scan dialog, so the scan stays offered.
    expect(
      shouldProbeOcrCapability({ ...base, labsOcr: state("consent_required") }),
    ).toBe(true);
    for (const reason of [
      "operator_disabled",
      "no_provider",
      "module_disabled",
      "not_permitted_for_record",
      "check_failed",
    ]) {
      expect(
        shouldProbeOcrCapability({ ...base, labsOcr: state(reason) }),
      ).toBe(false);
    }
  });
});
