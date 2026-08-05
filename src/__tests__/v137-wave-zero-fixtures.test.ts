import { describe, expect, it } from "vitest";

import {
  ADMITTED_MUTATING_HANDLERS,
  SHARING_DOMAINS,
} from "../../tests/fixtures/v137/sharing-matrix";

describe("sharing and handler inventories", () => {
  it("freezes the exact sharing-domain vocabulary", () => {
    expect(SHARING_DOMAINS).toEqual([
      "measurements",
      "medications",
      "labs",
      "profile",
      "illness",
      "mind",
      "cycle",
      "documents",
    ]);
  });

  it("keeps every admitted mutation uniquely addressable and fully controlled", () => {
    expect(ADMITTED_MUTATING_HANDLERS).toHaveLength(62);
    expect(
      new Set(
        ADMITTED_MUTATING_HANDLERS.map(
          ({ route, action }) => `${route}#${action}`,
        ),
      ).size,
    ).toBe(ADMITTED_MUTATING_HANDLERS.length);

    for (const handler of ADMITTED_MUTATING_HANDLERS) {
      expect(handler.ownRecord.expected).toBe("allow");
      expect(handler.deniedLevel.expected).toBe("deny");
      expect(handler.admittedLevel.expected).toBe("allow");
      expect(handler.actorAttribution.field).toBe("actorUserId");
      expect(handler.resultingEffect.expected).toBe("applied-once");
      expect(handler.encryptedFieldCarveOut).toBe(
        "never-assert-decrypted-field-content",
      );
    }
  });
});
