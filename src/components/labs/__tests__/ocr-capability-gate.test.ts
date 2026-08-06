import { describe, expect, it } from "vitest";

import { shouldProbeOcrCapability } from "../use-ocr-extract";

describe("shouldProbeOcrCapability", () => {
  it("runs the owner-only capability probe only when the scan control can render", () => {
    const ownerControl = {
      isAuthenticated: true,
      isLoading: false,
      labsEnabled: true,
      mounted: true,
      canManage: true,
    };

    expect(shouldProbeOcrCapability(ownerControl)).toBe(true);
    expect(
      shouldProbeOcrCapability({ ...ownerControl, isAuthenticated: false }),
    ).toBe(false);
    expect(
      shouldProbeOcrCapability({ ...ownerControl, canManage: false }),
    ).toBe(false);
    expect(
      shouldProbeOcrCapability({ ...ownerControl, labsEnabled: false }),
    ).toBe(false);
    expect(shouldProbeOcrCapability({ ...ownerControl, mounted: false })).toBe(
      false,
    );
  });
});
