import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";

let sequence = 0;

async function createUser(label: string, managed = false) {
  const suffix = sequence++;
  return getPrismaClient().user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      managedProfileAt: managed ? new Date() : null,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("notification attribution (real Postgres)", () => {
  it("persistence retains distinct record and recipient principals", async () => {
    const recordUser = await createUser("record", true);
    const recipientUser = await createUser("recipient");

    recordPushAttempt({
      recordUserId: recordUser.id,
      recipientUserId: recipientUser.id,
      channel: "NTFY",
      eventType: "MEDICATION_REMINDER",
      result: "ok",
    });

    await vi.waitFor(async () => {
      const attempt = await getPrismaClient().pushAttempt.findFirstOrThrow({
        where: {
          recordUserId: recordUser.id,
          recipientUserId: recipientUser.id,
        },
        select: {
          recordUserId: true,
          recipientUserId: true,
          channel: true,
          eventType: true,
        },
      });

      expect(attempt).toEqual({
        recordUserId: recordUser.id,
        recipientUserId: recipientUser.id,
        channel: "NTFY",
        eventType: "MEDICATION_REMINDER",
      });
    });
  });

  it("persistence leaves explicit self attribution unchanged", async () => {
    const self = await createUser("self");

    const attempt = await getPrismaClient().pushAttempt.create({
      data: {
        userId: self.id,
        recordUserId: self.id,
        recipientUserId: self.id,
        channel: "NTFY",
        eventType: "MEDICATION_REMINDER",
        result: "ok",
      },
      select: {
        userId: true,
        recordUserId: true,
        recipientUserId: true,
      },
    });

    expect(attempt).toEqual({
      userId: self.id,
      recordUserId: self.id,
      recipientUserId: self.id,
    });
  });

  it("persistence maps an omitted pair from the legacy recipient", async () => {
    const self = await createUser("legacy");

    const attempt = await getPrismaClient().pushAttempt.create({
      data: {
        userId: self.id,
        channel: "NTFY",
        eventType: "MEDICATION_REMINDER",
        result: "ok",
      },
      select: {
        recordUserId: true,
        recipientUserId: true,
      },
    });

    expect(attempt).toEqual({
      recordUserId: self.id,
      recipientUserId: self.id,
    });
  });

  it("persistence rejects a partial or contradictory principal pair atomically", async () => {
    const recordUser = await createUser("record", true);
    const recipientUser = await createUser("recipient");
    const otherUser = await createUser("other");

    await expect(
      getPrismaClient().pushAttempt.create({
        data: {
          userId: recipientUser.id,
          recordUserId: recordUser.id,
          channel: "NTFY",
          eventType: "MEDICATION_REMINDER",
          result: "ok",
        },
      }),
    ).rejects.toThrow("push attempt attribution requires both principals");

    await expect(
      getPrismaClient().pushAttempt.create({
        data: {
          userId: otherUser.id,
          recordUserId: recordUser.id,
          recipientUserId: recipientUser.id,
          channel: "NTFY",
          eventType: "MEDICATION_REMINDER",
          result: "ok",
        },
      }),
    ).rejects.toThrow("push attempt recipient must match user_id");

    expect(await getPrismaClient().pushAttempt.count()).toBe(0);
  });

  it("persistence refuses a managed recipient and cascades an attributed recipient deletion", async () => {
    const recordUser = await createUser("record", true);
    const recipientUser = await createUser("recipient");
    const managedRecipient = await createUser("managed-recipient", true);

    await expect(
      getPrismaClient().pushAttempt.create({
        data: {
          userId: managedRecipient.id,
          recordUserId: recordUser.id,
          recipientUserId: managedRecipient.id,
          channel: "NTFY",
          eventType: "MEDICATION_REMINDER",
          result: "ok",
        },
      }),
    ).rejects.toThrow("managed profile cannot receive notification delivery");

    const attempt = await getPrismaClient().pushAttempt.create({
      data: {
        userId: recipientUser.id,
        recordUserId: recordUser.id,
        recipientUserId: recipientUser.id,
        channel: "NTFY",
        eventType: "MEDICATION_REMINDER",
        result: "ok",
      },
    });
    await getPrismaClient().user.delete({ where: { id: recipientUser.id } });

    expect(
      await getPrismaClient().pushAttempt.findUnique({
        where: { id: attempt.id },
      }),
    ).toBeNull();
  });
});
