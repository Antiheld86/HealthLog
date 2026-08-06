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
});
