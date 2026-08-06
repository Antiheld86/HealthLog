import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    notificationChannel: {
      findMany: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (value: string) => value,
  encrypt: (value: string) => value,
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: vi.fn(),
    addMeta: vi.fn(),
  }),
}));

const sendViaWebPushMock = vi.fn();

vi.mock("@/lib/notifications/senders/apns", () => ({
  sendViaApns: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/email", () => ({
  sendViaEmail: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/ntfy", () => ({
  sendViaNtfy: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/telegram", () => ({
  sendViaTelegram: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/web-push", () => ({
  sendViaWebPush: (...args: unknown[]) => sendViaWebPushMock(...args),
}));
vi.mock("@/lib/notifications/senders/webhook", () => ({
  sendViaWebhook: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

const recordUserId = "managed-record";
const recipientUserId = "guardian-recipient";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    managedProfileAt: new Date(),
  } as never);
  vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
    {
      id: "recipient-channel",
      userId: recipientUserId,
      type: "WEB_PUSH",
      config: "{}",
      nextRetryAt: null,
      preferences: [],
    },
  ] as never);
  vi.mocked(prisma.notificationChannel.update).mockResolvedValue({
    consecutiveFailures: 0,
  } as never);
  sendViaWebPushMock.mockResolvedValue({ ok: true });
});

describe("notification delivery identity", () => {
  it("principal resolution uses the recipient channel for a managed record", async () => {
    const outcome = await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordUserId,
      recordUserId,
      recipientUserId,
      title: "Record content",
      message: "Record schedule",
    });

    expect(outcome).toEqual({
      dispatched: true,
      channelsAttempted: 1,
      channelsSucceeded: 1,
    });
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: recipientUserId, enabled: true },
      }),
    );
    expect(sendViaWebPushMock).toHaveBeenCalledWith(
      recipientUserId,
      expect.objectContaining({
        userId: recordUserId,
        recordUserId,
        recipientUserId,
        title: "Record content",
        message: "Record schedule",
      }),
    );
  });

  it("refuses a managed record without an explicit recipient", async () => {
    const outcome = await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordUserId,
      title: "Record content",
      message: "Record schedule",
    });

    expect(outcome).toEqual({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    });
    expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
    expect(sendViaWebPushMock).not.toHaveBeenCalled();
  });

  it("uses the recipient preference without changing record content", async () => {
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      {
        id: "recipient-channel",
        userId: recipientUserId,
        type: "WEB_PUSH",
        config: "{}",
        nextRetryAt: null,
        preferences: [{ eventType: "MEDICATION_REMINDER", enabled: false }],
      },
    ] as never);

    const outcome = await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordUserId,
      recordUserId,
      recipientUserId,
      title: "Record content",
      message: "Record schedule",
    });

    expect(outcome).toEqual({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    });
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: recipientUserId, enabled: true },
      }),
    );
    expect(sendViaWebPushMock).not.toHaveBeenCalled();
  });
});
