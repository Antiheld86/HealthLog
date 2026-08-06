import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";

const findFirstMock = vi.fn();
const createMock = vi.fn();
const queryRawMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    $transaction: (...args: unknown[]) => transactionMock(...args),
    notificationEvent: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
      create: (...args: unknown[]) => createMock(...args),
    },
  },
}));

import { claimNotificationEvent } from "../reminder-dedup";

beforeEach(() => {
  findFirstMock.mockReset().mockResolvedValue(null);
  createMock.mockReset().mockResolvedValue({ id: "event" });
  queryRawMock.mockReset().mockResolvedValue([{ locked: 1 }]);
  transactionMock.mockReset().mockImplementation(async (run) => run(prisma));
});

describe("reminder dedup anchors", () => {
  it("claims one record-scoped event under a short transaction lock", async () => {
    const now = new Date("2026-08-06T08:00:00.000Z");

    await expect(
      claimNotificationEvent(prisma as never, {
        recordUserId: "managed-record",
        eventType: "MEDICATION_REMINDER",
        dedupKey: "med:slot",
        since: now,
      }),
    ).resolves.toBe(true);

    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recordUserId: "managed-record",
          eventType: "MEDICATION_REMINDER",
          dedupKey: "med:slot",
        }),
      }),
    );
    expect(createMock).toHaveBeenCalledWith({
      data: {
        recordUserId: "managed-record",
        eventType: "MEDICATION_REMINDER",
        dedupKey: "med:slot",
      },
    });
  });

  it("does not claim when the locked window already contains the event", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "prior" });

    await expect(
      claimNotificationEvent(prisma as never, {
        recordUserId: "managed-record",
        eventType: "MEDICATION_REMINDER",
        dedupKey: "med:slot",
        since: new Date("2026-08-06T08:00:00.000Z"),
      }),
    ).resolves.toBe(false);

    expect(createMock).not.toHaveBeenCalled();
  });
});
