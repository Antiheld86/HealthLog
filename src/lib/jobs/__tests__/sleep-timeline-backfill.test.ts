/**
 * v1.17.1 — sleep-timeline backfill self-convergence tests (mocked).
 *   - discovery only matches connections whose sleep rows predate the fix
 *     (`sleepTimelineBackfillAt IS NULL`), for both WHOOP and Withings;
 *   - a completed pass DELETES the source's SLEEP_DURATION rows, re-syncs, and
 *     stamps `sleepTimelineBackfillAt` so the next discovery drops the account
 *     (idempotent across reboots);
 *   - the discovery enqueue is singleton-keyed per (provider, user).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, bossSend, syncUserWhoop, syncWithingsSleep } = vi.hoisted(
  () => ({
    prismaMock: {
      whoopConnection: { findMany: vi.fn(), update: vi.fn() },
      withingsConnection: { findMany: vi.fn(), update: vi.fn() },
      measurement: { deleteMany: vi.fn() },
    },
    bossSend: vi.fn(),
    syncUserWhoop: vi.fn(),
    syncWithingsSleep: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: bossSend }),
}));

vi.mock("@/lib/whoop/sync", () => ({
  syncUserWhoop: (...a: unknown[]) => syncUserWhoop(...a),
}));

vi.mock("@/lib/withings/sync-sleep", () => ({
  syncUserSleep: (...a: unknown[]) => syncWithingsSleep(...a),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => null,
}));

import {
  enqueueBootTimeSleepTimelineBackfill,
  runSleepTimelineBackfillForUser,
} from "../sleep-timeline-backfill";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enqueueBootTimeSleepTimelineBackfill — discovery", () => {
  it("queries un-backfilled WHOOP + Withings connections and enqueues one job per (provider, user)", async () => {
    prismaMock.whoopConnection.findMany.mockResolvedValue([{ userId: "w1" }]);
    prismaMock.withingsConnection.findMany.mockResolvedValue([
      { userId: "v1" },
    ]);
    bossSend.mockResolvedValue("job-id");

    const result = await enqueueBootTimeSleepTimelineBackfill();

    expect(prismaMock.whoopConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sleepTimelineBackfillAt: null } }),
    );
    expect(prismaMock.withingsConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sleepTimelineBackfillAt: null } }),
    );
    expect(result.enqueued).toBe(2);
    expect(bossSend).toHaveBeenCalledWith(
      "sleep-timeline-backfill",
      expect.objectContaining({ userId: "w1", provider: "WHOOP" }),
      expect.objectContaining({
        singletonKey: "sleep-timeline-backfill|WHOOP|w1",
      }),
    );
    expect(bossSend).toHaveBeenCalledWith(
      "sleep-timeline-backfill",
      expect.objectContaining({ userId: "v1", provider: "WITHINGS" }),
      expect.objectContaining({
        singletonKey: "sleep-timeline-backfill|WITHINGS|v1",
      }),
    );
  });

  it("self-converges: no un-backfilled connections → nothing enqueued", async () => {
    prismaMock.whoopConnection.findMany.mockResolvedValue([]);
    prismaMock.withingsConnection.findMany.mockResolvedValue([]);

    const result = await enqueueBootTimeSleepTimelineBackfill();

    expect(result.enqueued).toBe(0);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("never throws — surfaces a discovery error through the result value", async () => {
    prismaMock.whoopConnection.findMany.mockRejectedValue(new Error("db down"));
    prismaMock.withingsConnection.findMany.mockResolvedValue([]);

    const result = await enqueueBootTimeSleepTimelineBackfill();

    expect(result.error).toBe("db down");
    expect(result.enqueued).toBe(0);
  });
});

describe("runSleepTimelineBackfillForUser", () => {
  it("WHOOP: deletes the source's sleep rows, full-syncs, and stamps the marker", async () => {
    prismaMock.measurement.deleteMany.mockResolvedValue({ count: 5 });
    syncUserWhoop.mockResolvedValue({ imported: 42, failed: false });
    prismaMock.whoopConnection.update.mockResolvedValue({});

    const { deleted, imported } = await runSleepTimelineBackfillForUser(
      "w1",
      "WHOOP",
    );

    expect(deleted).toBe(5);
    expect(imported).toBe(42);
    expect(prismaMock.measurement.deleteMany).toHaveBeenCalledWith({
      where: { userId: "w1", type: "SLEEP_DURATION", source: "WHOOP" },
    });
    expect(syncUserWhoop).toHaveBeenCalledWith("w1", { fullSync: true });
    const updateArg = prismaMock.whoopConnection.update.mock.calls[0]![0];
    expect(updateArg.where).toEqual({ userId: "w1" });
    expect(updateArg.data.sleepTimelineBackfillAt).toBeInstanceOf(Date);
  });

  it("WHOOP: a failed verdict THROWS without stamping the marker (gated re-sync)", async () => {
    // The rows were already deleted; a partial re-sync must not stamp the
    // completion marker over the gap — it throws so pg-boss retries.
    prismaMock.measurement.deleteMany.mockResolvedValue({ count: 5 });
    syncUserWhoop.mockResolvedValue({ imported: 3, failed: true });

    await expect(
      runSleepTimelineBackfillForUser("w1", "WHOOP"),
    ).rejects.toThrow(/incomplete/);
    expect(prismaMock.whoopConnection.update).not.toHaveBeenCalled();
  });

  it("WITHINGS: deletes the source's sleep rows, re-syncs, and stamps the marker", async () => {
    prismaMock.measurement.deleteMany.mockResolvedValue({ count: 3 });
    syncWithingsSleep.mockResolvedValue(7);
    prismaMock.withingsConnection.update.mockResolvedValue({});

    const { deleted, imported } = await runSleepTimelineBackfillForUser(
      "v1",
      "WITHINGS",
    );

    expect(deleted).toBe(3);
    expect(imported).toBe(7);
    expect(prismaMock.measurement.deleteMany).toHaveBeenCalledWith({
      where: { userId: "v1", type: "SLEEP_DURATION", source: "WITHINGS" },
    });
    expect(syncWithingsSleep).toHaveBeenCalledWith("v1", { fullSync: true });
    const updateArg = prismaMock.withingsConnection.update.mock.calls[0]![0];
    expect(updateArg.where).toEqual({ userId: "v1" });
    expect(updateArg.data.sleepTimelineBackfillAt).toBeInstanceOf(Date);
  });
});
