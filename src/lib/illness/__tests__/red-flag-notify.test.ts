/**
 * v1.18.4 — illness red-flag escalation push.
 *
 * Pins: empty red-flags is a no-op; a fresh red flag dispatches an URGENT
 * localised SYSTEM_ALERT; a recent ledger row de-dupes (no re-fire); the
 * fever reason is preferred for the body; failures never throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstMock = vi.fn();
const createMock = vi.fn();
const dispatchMock = vi.fn();
const userFindUniqueMock = vi.fn();
const claimMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => userFindUniqueMock(...a),
    },
    notificationEvent: {
      findFirst: (...a: unknown[]) => findFirstMock(...a),
      create: (...a: unknown[]) => createMock(...a),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addMeta: vi.fn(), addWarning: vi.fn() }),
}));

vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: (...a: unknown[]) => dispatchMock(...a),
}));

vi.mock("@/lib/notifications/reminder-dedup", () => ({
  claimNotificationEvent: (...a: unknown[]) => claimMock(...a),
}));

import { notifyIllnessRedFlag } from "../red-flag-notify";
import type { IllnessRedFlag } from "../correlation";

const spo2Flag: IllnessRedFlag = {
  type: "SPO2" as never,
  reason: "sustained_low_spo2",
  worstValue: 89,
  days: 3,
};
const feverFlag: IllnessRedFlag = {
  type: "BODY_TEMPERATURE" as never,
  reason: "sustained_fever",
  worstValue: 39.1,
  days: 3,
};

beforeEach(() => {
  userFindUniqueMock.mockReset().mockResolvedValue({ managedProfileAt: null });
  findFirstMock.mockReset().mockResolvedValue(null);
  createMock.mockReset().mockResolvedValue({});
  dispatchMock.mockReset().mockResolvedValue(undefined);
  claimMock.mockReset().mockResolvedValue(true);
});

afterEach(() => vi.clearAllMocks());

describe("notifyIllnessRedFlag", () => {
  it("no-op when there are no red flags", async () => {
    await notifyIllnessRedFlag({ userId: "u1", episodeId: "e1", redFlags: [] });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("dispatches an URGENT SYSTEM_ALERT for a fresh red flag", async () => {
    await notifyIllnessRedFlag({
      userId: "u1",
      episodeId: "e1",
      redFlags: [spo2Flag],
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const opts = dispatchMock.mock.calls[0][0];
    expect(opts.urgent).toBe(true);
    expect(opts.eventType).toBe("SYSTEM_ALERT");
    expect(opts.userId).toBe("u1");
    expect(opts.titleKey).toBe("illness.correlation.redFlagTitle");
    expect(opts.messageKey).toBe("illness.correlation.redFlagSpo2");
  });

  it("prefers the fever reason for the body when both flags fire", async () => {
    await notifyIllnessRedFlag({
      userId: "u1",
      episodeId: "e1",
      redFlags: [spo2Flag, feverFlag],
    });
    expect(dispatchMock.mock.calls[0][0].messageKey).toBe(
      "illness.correlation.redFlagFever",
    );
  });

  it("does not dispatch when a concurrent claimant already owns the episode", async () => {
    claimMock.mockResolvedValueOnce(false);
    await notifyIllnessRedFlag({
      userId: "u1",
      episodeId: "e1",
      redFlags: [feverFlag],
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(claimMock).toHaveBeenCalledTimes(1);
  });

  it("claims the record event anchor before dispatching", async () => {
    await notifyIllnessRedFlag({
      userId: "u1",
      episodeId: "e9",
      redFlags: [feverFlag],
    });
    expect(claimMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recordUserId: "u1",
        eventType: "SYSTEM_ALERT",
        dedupKey: expect.stringContaining("e9"),
      }),
    );
  });

  it("does not dispatch or write an anchor for a managed profile", async () => {
    userFindUniqueMock.mockResolvedValueOnce({
      managedProfileAt: new Date("2026-08-06T00:00:00.000Z"),
    });

    await notifyIllnessRedFlag({
      userId: "managed-record",
      episodeId: "e1",
      redFlags: [feverFlag],
    });

    expect(claimMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("never throws when dispatch fails", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      notifyIllnessRedFlag({
        userId: "u1",
        episodeId: "e1",
        redFlags: [feverFlag],
      }),
    ).resolves.toBeUndefined();
  });
});
