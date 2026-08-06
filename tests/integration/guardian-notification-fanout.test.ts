import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({
  ntfy: [] as Array<{
    recipientUserId: string;
    title: string;
    message: string;
  }>,
  apns: [] as Array<{ recipientUserId: string; recordUserId?: string }>,
}));

vi.mock("@/lib/notifications/senders/ntfy", () => ({
  sendViaNtfy: async (
    _config: unknown,
    payload: { recipientUserId?: string; title: string; message: string },
  ) => {
    sent.ntfy.push({
      recipientUserId: payload.recipientUserId ?? "missing",
      title: payload.title,
      message: payload.message,
    });
    return { ok: true };
  },
}));

vi.mock("@/lib/notifications/senders/apns", () => ({
  sendViaApns: async (
    recipientUserId: string,
    payload: { recordUserId?: string },
  ) => {
    sent.apns.push({ recipientUserId, recordUserId: payload.recordUserId });
    return { ok: true };
  },
}));

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
  type: "NTFY" | "APNS",
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
});
