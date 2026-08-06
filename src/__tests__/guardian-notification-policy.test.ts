import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, findMany } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique },
    accountGrant: { findMany },
  },
}));

import {
  isManagedGuardianFanoutAllowed,
  resolveManagedGuardianRecipientIds,
} from "@/lib/notifications/delivery-identity";

const recordUserId = "managed-record";

function payload(over: Record<string, unknown> = {}) {
  return {
    eventType: "MEDICATION_REMINDER" as const,
    userId: recordUserId,
    title: "Record content",
    message: "Record schedule",
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  findUnique.mockResolvedValue({ managedProfileAt: new Date() });
  findMany.mockResolvedValue([
    { granteeId: "guardian-one", grantee: { managedProfileAt: null } },
  ]);
});

describe("guardian notification policy — allowlist and eligibility", () => {
  it("allows exactly medication, measurement, low-stock, and explicitly tagged safety-floor alerts", () => {
    expect(isManagedGuardianFanoutAllowed(payload())).toBe(true);
    expect(
      isManagedGuardianFanoutAllowed(
        payload({ eventType: "MEASUREMENT_REMINDER" }),
      ),
    ).toBe(true);
    expect(
      isManagedGuardianFanoutAllowed(
        payload({ eventType: "MEDICATION_LOW_STOCK" }),
      ),
    ).toBe(true);
    expect(
      isManagedGuardianFanoutAllowed(
        payload({
          eventType: "SYSTEM_ALERT",
          managedFanoutEvent: "SAFETY_FLOOR_ALERT",
        }),
      ),
    ).toBe(true);

    expect(
      isManagedGuardianFanoutAllowed(payload({ eventType: "SYSTEM_ALERT" })),
    ).toBe(false);
    expect(
      isManagedGuardianFanoutAllowed(
        payload({ eventType: "MEASUREMENT_ANOMALY" }),
      ),
    ).toBe(false);
    expect(
      isManagedGuardianFanoutAllowed(
        payload({
          eventType: "SYSTEM_ALERT",
          managedFanoutEvent: "ILLNESS_RED_FLAG",
        }),
      ),
    ).toBe(false);
  });

  it("enumerates only active Guardians of the marked record", async () => {
    await expect(
      resolveManagedGuardianRecipientIds(payload()),
    ).resolves.toEqual(["guardian-one"]);

    expect(findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ grantorId: recordUserId }),
      select: {
        granteeId: true,
        grantee: { select: { managedProfileAt: true } },
      },
    });
  });

  it("does not fan out unmarked records, disallowed events, self delivery, or invalid Guardians", async () => {
    findUnique.mockResolvedValueOnce({ managedProfileAt: null });
    await expect(
      resolveManagedGuardianRecipientIds(payload()),
    ).resolves.toBeNull();

    await expect(
      resolveManagedGuardianRecipientIds(
        payload({ eventType: "MEASUREMENT_ANOMALY" }),
      ),
    ).resolves.toBeNull();

    findMany.mockResolvedValueOnce([
      { granteeId: recordUserId, grantee: { managedProfileAt: null } },
      {
        granteeId: "managed-guardian",
        grantee: { managedProfileAt: new Date() },
      },
      { granteeId: "guardian-two", grantee: { managedProfileAt: null } },
    ]);
    await expect(
      resolveManagedGuardianRecipientIds(payload()),
    ).resolves.toEqual(["guardian-two"]);
  });
});
