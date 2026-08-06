import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";

const findFirstMock = vi.fn();
const createMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    notificationEvent: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
      create: (...args: unknown[]) => createMock(...args),
    },
  },
}));

import {
  hasReminderDedupAnchor,
  writeReminderDedupAnchor,
} from "../reminder-dedup";

beforeEach(() => {
  findFirstMock.mockReset().mockResolvedValue(null);
  createMock.mockReset().mockResolvedValue({ id: "event" });
});

describe("reminder dedup anchors", () => {
  it("looks up a record-scoped event rather than a delivery attempt", async () => {
    const now = new Date("2026-08-06T08:00:00.000Z");

    await expect(
      hasReminderDedupAnchor(prisma as never, {
        userId: "managed-record",
        eventType: "MEDICATION_REMINDER",
        reason: "med:slot",
        now,
      }),
    ).resolves.toBe(false);

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recordUserId: "managed-record",
          eventType: "MEDICATION_REMINDER",
          dedupKey: "med:slot",
        }),
      }),
    );
  });

  it("writes an append-only record event without inventing a recipient", async () => {
    await writeReminderDedupAnchor(prisma as never, {
      userId: "managed-record",
      eventType: "MEDICATION_REMINDER",
      reason: "med:slot",
    });

    expect(createMock).toHaveBeenCalledWith({
      data: {
        recordUserId: "managed-record",
        eventType: "MEDICATION_REMINDER",
        dedupKey: "med:slot",
      },
    });
  });
});
