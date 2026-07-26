/**
 * v1.16.16 (iOS #17) — `runWhoopResourceSync` dispatch tests (mocked syncs).
 *
 * The webhook now carries the resource id; the worker must do a targeted
 * fetch-by-id refresh when it is present, fall back to the per-user collection
 * walk when a webhook job omits the id, and walk every connection only on the
 * cron tick (no userId on any job). One user's failure never starves the
 * cohort.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";

const {
  syncUserWorkout,
  syncWhoopWorkoutById,
  findManyMock,
  recordWhoopSyncFailureMock,
  recordSyncSuccessMock,
} = vi.hoisted(() => ({
  syncUserWorkout: vi.fn<(...a: unknown[]) => Promise<number>>(async () => 0),
  syncWhoopWorkoutById: vi.fn<(...a: unknown[]) => Promise<number>>(
    async () => 0,
  ),
  findManyMock: vi.fn<(...a: unknown[]) => Promise<Array<{ userId: string }>>>(
    async () => [],
  ),
  recordWhoopSyncFailureMock: vi.fn<(...a: unknown[]) => Promise<void>>(
    async () => {},
  ),
  recordSyncSuccessMock: vi.fn<(...a: unknown[]) => Promise<void>>(
    async () => {},
  ),
}));

// Keep the real marker helpers (isSyncFailureRecorded / markSyncFailureRecorded)
// but stub the DB-touching writers so this stays a unit test.
vi.mock("@/lib/integrations/status", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/status")>()),
  recordSyncSuccess: recordSyncSuccessMock,
}));
vi.mock("@/lib/whoop/sync-core", async (orig) => ({
  ...(await orig<typeof import("@/lib/whoop/sync-core")>()),
  recordWhoopSyncFailure: recordWhoopSyncFailureMock,
}));

vi.mock("@/lib/whoop/sync-recovery", () => ({
  syncUserRecovery: vi.fn(async () => 0),
  syncWhoopRecoveryById: vi.fn(async () => 0),
}));
vi.mock("@/lib/whoop/sync-sleep", () => ({
  syncUserSleep: vi.fn(async () => 0),
  syncWhoopSleepById: vi.fn(async () => 0),
}));
vi.mock("@/lib/whoop/sync-cycle", () => ({
  syncUserCycle: vi.fn(async () => 0),
}));
vi.mock("@/lib/whoop/sync-workout", () => ({
  syncUserWorkout: (...a: unknown[]) => syncUserWorkout(...a),
  syncWhoopWorkoutById: (...a: unknown[]) => syncWhoopWorkoutById(...a),
}));

vi.mock("@/lib/jobs/worker-status", () => ({ recordError: vi.fn() }));

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (evt: {
      setBackground: () => void;
      setError: () => void;
      addWarning: () => void;
    }) => Promise<void>,
  ) =>
    fn({
      setBackground: vi.fn(),
      setError: vi.fn(),
      addWarning: vi.fn(),
    }),
}));

vi.mock("../reminder/shared", () => ({
  getWorkerPrisma: () => ({
    whoopConnection: { findMany: (...a: unknown[]) => findManyMock(...a) },
  }),
}));

import { handleWhoopWorkoutSync } from "../reminder/whoop-sync";
import { markSyncFailureRecorded } from "@/lib/integrations/status";

function job(data: { userId?: string; resourceId?: string }): Job<{
  userId?: string;
  resourceId?: string;
}> {
  return { data } as Job<{ userId?: string; resourceId?: string }>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runWhoopResourceSync dispatch", () => {
  it("a webhook job with a resourceId does a targeted fetch-by-id refresh", async () => {
    await handleWhoopWorkoutSync([job({ userId: "u1", resourceId: "w-9" })]);

    expect(syncWhoopWorkoutById).toHaveBeenCalledWith("u1", "w-9");
    expect(syncUserWorkout).not.toHaveBeenCalled();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("a webhook job without a resourceId falls back to the per-user collection", async () => {
    await handleWhoopWorkoutSync([job({ userId: "u1" })]);

    expect(syncUserWorkout).toHaveBeenCalledWith("u1");
    expect(syncWhoopWorkoutById).not.toHaveBeenCalled();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("a cron tick (no userId) walks every connection's collection", async () => {
    findManyMock.mockResolvedValue([{ userId: "a" }, { userId: "b" }]);

    await handleWhoopWorkoutSync([job({})]);

    expect(findManyMock).toHaveBeenCalled();
    expect(syncUserWorkout).toHaveBeenCalledTimes(2);
    expect(syncWhoopWorkoutById).not.toHaveBeenCalled();
  });

  it("one user's failure never starves the rest of the cohort", async () => {
    findManyMock.mockResolvedValue([{ userId: "a" }, { userId: "b" }]);
    syncUserWorkout.mockRejectedValueOnce(new Error("boom for a"));

    await expect(handleWhoopWorkoutSync([job({})])).resolves.toBeUndefined();
    // Both users were attempted despite the first throwing.
    expect(syncUserWorkout).toHaveBeenCalledTimes(2);
  });
});

describe("runWhoopResourceSync — WH-4 write-path ledger honesty", () => {
  it("records an UNMARKED write-path throw once (a stale-green pill otherwise)", async () => {
    // A `MeasurementReconciliationError` out of the upsert reaches no ledger on
    // the cron path before WH-4 — the pill stays green through a persistent
    // write failure. The catch now records it once.
    syncUserWorkout.mockRejectedValueOnce(new Error("write failed"));

    await handleWhoopWorkoutSync([job({ userId: "u1" })]);

    expect(recordWhoopSyncFailureMock).toHaveBeenCalledTimes(1);
    expect(recordWhoopSyncFailureMock).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ message: "write failed" }),
      // Attributed to the leg it came from, so the recovery leg's success at
      // :05 cannot clear it.
      "workout",
    );
  });

  it("does NOT re-record a MARKED fetch error (no double-record)", async () => {
    // A fetch hard-fail was already recorded + marked in
    // `handleCollectionFetchError`; the cron catch must skip it.
    syncUserWorkout.mockRejectedValueOnce(
      markSyncFailureRecorded(new Error("already recorded fetch error")),
    );

    await handleWhoopWorkoutSync([job({ userId: "u1" })]);

    expect(recordWhoopSyncFailureMock).not.toHaveBeenCalled();
  });
});
