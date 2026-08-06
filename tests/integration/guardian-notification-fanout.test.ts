import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({
  deliveries: [] as Array<{
    channel: "NTFY" | "APNS" | "WEB_PUSH" | "TELEGRAM";
    recordUserId: string;
    recipientUserId: string;
  }>,
  ntfy: [] as Array<{
    recipientUserId: string;
    title: string;
    message: string;
  }>,
  apns: [] as Array<{ recipientUserId: string; recordUserId?: string }>,
}));

vi.mock("@/lib/notifications/senders/ntfy", async () => {
  const { recordPushAttemptForPayload } = await vi.importActual<
    typeof import("@/lib/notifications/senders/push-attempt-record")
  >("@/lib/notifications/senders/push-attempt-record");
  return {
    sendViaNtfy: async (
      _config: unknown,
      payload: {
        userId: string;
        recordUserId?: string;
        recipientUserId?: string;
        eventType: string;
        title: string;
        message: string;
      },
    ) => {
      const recipientUserId = payload.recipientUserId ?? payload.userId;
      sent.ntfy.push({
        recipientUserId,
        title: payload.title,
        message: payload.message,
      });
      sent.deliveries.push({
        channel: "NTFY",
        recordUserId: payload.recordUserId ?? payload.userId,
        recipientUserId,
      });
      recordPushAttemptForPayload(payload, recipientUserId, {
        userId: payload.userId,
        channel: "NTFY",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true };
    },
  };
});

vi.mock("@/lib/notifications/senders/apns", async () => {
  const { recordPushAttemptForPayload } = await vi.importActual<
    typeof import("@/lib/notifications/senders/push-attempt-record")
  >("@/lib/notifications/senders/push-attempt-record");
  return {
    sendViaApns: async (
      recipientUserId: string,
      payload: { userId: string; recordUserId?: string; eventType: string },
    ) => {
      sent.apns.push({ recipientUserId, recordUserId: payload.recordUserId });
      sent.deliveries.push({
        channel: "APNS",
        recordUserId: payload.recordUserId ?? payload.userId,
        recipientUserId,
      });
      recordPushAttemptForPayload(payload, recipientUserId, {
        userId: payload.userId,
        channel: "APNS",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true };
    },
  };
});

vi.mock("@/lib/notifications/senders/web-push", async () => {
  const { recordPushAttemptForPayload } = await vi.importActual<
    typeof import("@/lib/notifications/senders/push-attempt-record")
  >("@/lib/notifications/senders/push-attempt-record");
  return {
    sendViaWebPush: async (
      recipientUserId: string,
      payload: { userId: string; recordUserId?: string; eventType: string },
    ) => {
      sent.deliveries.push({
        channel: "WEB_PUSH",
        recordUserId: payload.recordUserId ?? payload.userId,
        recipientUserId,
      });
      recordPushAttemptForPayload(payload, recipientUserId, {
        userId: payload.userId,
        channel: "WEB_PUSH",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true };
    },
  };
});

vi.mock("@/lib/notifications/senders/telegram", async () => {
  const { recordPushAttemptForPayload } = await vi.importActual<
    typeof import("@/lib/notifications/senders/push-attempt-record")
  >("@/lib/notifications/senders/push-attempt-record");
  return {
    sendViaTelegram: async (
      _config: unknown,
      payload: {
        userId: string;
        recordUserId?: string;
        recipientUserId?: string;
        eventType: string;
      },
    ) => {
      const recipientUserId = payload.recipientUserId ?? payload.userId;
      sent.deliveries.push({
        channel: "TELEGRAM",
        recordUserId: payload.recordUserId ?? payload.userId,
        recipientUserId,
      });
      recordPushAttemptForPayload(payload, recipientUserId, {
        userId: payload.userId,
        channel: "TELEGRAM",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true };
    },
  };
});

import { encrypt } from "@/lib/crypto";
import type { Locale } from "@/lib/i18n/config";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { getPrismaClient, truncateAllTables } from "./setup";

let sequence = 0;

async function createUser(input: {
  label: string;
  locale: "en" | "de";
  managed?: boolean;
  clientManaged?: boolean;
}) {
  const suffix = sequence++;
  return getPrismaClient().user.create({
    data: {
      username: `${input.label}-${suffix}`,
      email: `${input.label}-${suffix}@example.test`,
      locale: input.locale,
      managedProfileAt: input.managed ? new Date() : null,
      notificationPrefs: input.clientManaged
        ? { medication: { clientManaged: true } }
        : undefined,
    },
  });
}

async function addGuardian(recordUserId: string, recipientUserId: string) {
  await getPrismaClient().accountGrant.create({
    data: {
      grantorId: recordUserId,
      granteeId: recipientUserId,
      access: "MANAGE",
      acceptedAt: new Date(),
    },
  });
}

async function addChannel(
  userId: string,
  type: "NTFY" | "APNS" | "WEB_PUSH" | "TELEGRAM",
  enabled = true,
) {
  await getPrismaClient().notificationChannel.create({
    data: {
      userId,
      type,
      enabled,
      config: encrypt("{}"),
    },
  });
}

beforeEach(async () => {
  sent.deliveries.length = 0;
  sent.ntfy.length = 0;
  sent.apns.length = 0;
  await truncateAllTables(getPrismaClient());
});

describe("Guardian fan-out (real Postgres)", () => {
  it("isolates recipient locale and global preference across two Guardians and two records", async () => {
    const [recordA, recordB, guardianEn, guardianDe] = await Promise.all([
      createUser({ label: "record-a", locale: "en", managed: true }),
      createUser({ label: "record-b", locale: "de", managed: true }),
      createUser({ label: "guardian-en", locale: "en" }),
      createUser({ label: "guardian-de", locale: "de" }),
    ]);
    await Promise.all([
      addGuardian(recordA.id, guardianEn.id),
      addGuardian(recordA.id, guardianDe.id),
      addGuardian(recordB.id, guardianEn.id),
      addGuardian(recordB.id, guardianDe.id),
      addChannel(guardianEn.id, "NTFY"),
      addChannel(guardianDe.id, "NTFY"),
    ]);

    const renderForRecipient = (locale: Locale) => ({
      title: `title-${locale}`,
      message: `message-${locale}`,
    });
    await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordA.id,
      title: "record-a-title",
      message: "record-a-message",
      renderForRecipient,
    });

    expect(sent.ntfy).toEqual(
      expect.arrayContaining([
        {
          recipientUserId: guardianEn.id,
          title: "title-en",
          message: "message-en",
        },
        {
          recipientUserId: guardianDe.id,
          title: "title-de",
          message: "message-de",
        },
      ]),
    );

    await getPrismaClient().notificationPreference.create({
      data: {
        channel: {
          connect: { userId_type: { userId: guardianEn.id, type: "NTFY" } },
        },
        eventType: "MEDICATION_REMINDER",
        enabled: false,
      },
    });
    sent.ntfy.length = 0;

    await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordB.id,
      title: "record-b-title",
      message: "record-b-message",
      renderForRecipient,
    });

    expect(sent.ntfy).toEqual([
      {
        recipientUserId: guardianDe.id,
        title: "title-de",
        message: "message-de",
      },
    ]);
  });

  it("bypasses client-managed suppression for each Guardian but not self delivery", async () => {
    const [record, guardianEn, guardianDe] = await Promise.all([
      createUser({ label: "record", locale: "en", managed: true }),
      createUser({
        label: "guardian-en",
        locale: "en",
        clientManaged: true,
      }),
      createUser({
        label: "guardian-de",
        locale: "de",
        clientManaged: true,
      }),
    ]);
    await Promise.all([
      addGuardian(record.id, guardianEn.id),
      addGuardian(record.id, guardianDe.id),
      addChannel(guardianEn.id, "APNS"),
      addChannel(guardianDe.id, "APNS"),
    ]);

    await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: record.id,
      title: "record-title",
      message: "record-message",
    });

    expect(sent.apns).toEqual(
      expect.arrayContaining([
        { recipientUserId: guardianEn.id, recordUserId: record.id },
        { recipientUserId: guardianDe.id, recordUserId: record.id },
      ]),
    );
  });

  it("writes the complete two-record, two-Guardian, four-channel attribution matrix", async () => {
    const [recordA, recordB, guardianOne, guardianTwo, ordinaryRecord] =
      await Promise.all([
        createUser({ label: "record-a", locale: "en", managed: true }),
        createUser({ label: "record-b", locale: "de", managed: true }),
        createUser({ label: "guardian-one", locale: "en" }),
        createUser({ label: "guardian-two", locale: "de" }),
        createUser({ label: "ordinary-record", locale: "en" }),
      ]);
    const guardianIds = [guardianOne.id, guardianTwo.id];
    const recordIds = [recordA.id, recordB.id];
    const channelTypes = ["NTFY", "APNS", "WEB_PUSH", "TELEGRAM"] as const;

    await Promise.all([
      ...recordIds.flatMap((recordUserId) =>
        guardianIds.map((recipientUserId) =>
          addGuardian(recordUserId, recipientUserId),
        ),
      ),
      // An ordinary adult's MANAGE grant must never cause fan-out.
      addGuardian(ordinaryRecord.id, guardianOne.id),
      ...guardianIds.flatMap((userId) =>
        channelTypes.map((type) => addChannel(userId, type)),
      ),
    ]);

    await Promise.all(
      recordIds.map((userId) =>
        dispatchNotification({
          eventType: "MEDICATION_REMINDER",
          userId,
          title: "record reminder",
          message: "record message",
        }),
      ),
    );

    const expected = recordIds.flatMap((recordUserId) =>
      guardianIds.flatMap((recipientUserId) =>
        channelTypes.map((channel) => ({
          channel,
          recordUserId,
          recipientUserId,
        })),
      ),
    );
    expect(sent.deliveries).toHaveLength(expected.length);
    expect(sent.deliveries).toEqual(expect.arrayContaining(expected));
    expect(
      sent.deliveries.some((delivery) =>
        recordIds.includes(delivery.recipientUserId),
      ),
    ).toBe(false);

    await vi.waitFor(async () => {
      const attempts = await getPrismaClient().pushAttempt.findMany({
        where: { eventType: "MEDICATION_REMINDER" },
        select: { channel: true, recordUserId: true, recipientUserId: true },
      });
      expect(attempts).toHaveLength(expected.length);
      expect(attempts).toEqual(expect.arrayContaining(expected));
    });

    await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: ordinaryRecord.id,
      title: "ordinary reminder",
      message: "ordinary message",
    });

    expect(sent.deliveries).toHaveLength(expected.length);
    await expect(
      getPrismaClient().pushAttempt.count({
        where: { eventType: "MEDICATION_REMINDER" },
      }),
    ).resolves.toBe(expected.length);
  });
});
