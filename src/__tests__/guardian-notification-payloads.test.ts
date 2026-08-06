import { describe, expect, it } from "vitest";

import { isManagedGuardianDelivery } from "@/lib/notifications/managed-delivery";

describe("managed Guardian notification payload safety", () => {
  it("recognises only cross-account record delivery as managed Guardian delivery", () => {
    expect(
      isManagedGuardianDelivery({
        eventType: "MEDICATION_REMINDER",
        userId: "record-1",
        recordUserId: "record-1",
        recipientUserId: "guardian-1",
        title: "t",
        message: "m",
      }),
    ).toBe(true);

    expect(
      isManagedGuardianDelivery({
        eventType: "MEDICATION_REMINDER",
        userId: "user-1",
        recordUserId: "user-1",
        recipientUserId: "user-1",
        title: "t",
        message: "m",
      }),
    ).toBe(false);
  });
});
