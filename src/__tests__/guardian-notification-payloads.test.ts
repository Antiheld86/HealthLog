import { describe, expect, it } from "vitest";

import { isManagedGuardianDelivery } from "@/lib/notifications/managed-delivery";

describe("managed Guardian notification payload safety", () => {
  it("recognises only cross-account record delivery as managed Guardian delivery", () => {
    expect(
      isManagedGuardianDelivery({
        recordUserId: "record-1",
        recipientUserId: "guardian-1",
      }),
    ).toBe(true);

    expect(
      isManagedGuardianDelivery({
        recordUserId: "user-1",
        recipientUserId: "user-1",
      }),
    ).toBe(false);
  });
});
