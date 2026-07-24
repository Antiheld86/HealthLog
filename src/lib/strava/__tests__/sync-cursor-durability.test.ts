import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StravaWorkoutRow } from "../client";

const mocks = vi.hoisted(() => ({
  fetchActivities: vi.fn(),
  fetchActivityById: vi.fn(),
  mapActivity: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  updateUser: vi.fn(),
  createManyAndReturn: vi.fn(),
  updateWorkout: vi.fn(),
  getStravaConnection: vi.fn(),
  recordSyncFailure: vi.fn(),
  recordSyncSuccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
      update: mocks.updateUser,
    },
    workout: {
      createManyAndReturn: mocks.createManyAndReturn,
      update: mocks.updateWorkout,
    },
  },
}));
vi.mock("@/lib/arrivals/workout-emit", () => ({
  emitInsertedWorkoutArrival: vi.fn(async () => {}),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ addWarning: vi.fn() }),
}));
vi.mock("@/lib/integrations/status", () => ({
  recordSyncFailure: mocks.recordSyncFailure,
  recordSyncSuccess: mocks.recordSyncSuccess,
  toFailureKind: vi.fn(() => "transient"),
  markSyncFailureRecorded: <T>(err: T) => err,
}));
vi.mock("../credentials", () => ({
  getStravaConnection: mocks.getStravaConnection,
  getStravaClientCredentials: vi.fn(),
  storeStravaTokens: vi.fn(),
}));
vi.mock("../client", () => ({
  fetchActivities: mocks.fetchActivities,
  fetchActivityById: mocks.fetchActivityById,
  mapActivity: mocks.mapActivity,
  refreshAccessToken: vi.fn(),
  summaryHasHeartRate: vi.fn(() => true),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

import { runStravaBackfillForUser } from "@/lib/jobs/strava-backfill";
import { syncUserStrava } from "../sync";

const previousCursor = new Date("2026-07-01T08:00:00.000Z");
const firstStart = new Date("2026-07-18T08:00:00.000Z");
const secondStart = new Date("2026-07-19T08:00:00.000Z");
const thirdStart = new Date("2026-07-20T08:00:00.000Z");

function workout(externalId: string, startedAt: Date): StravaWorkoutRow {
  return {
    externalId,
    sportType: "running",
    startedAt,
    endedAt: new Date(startedAt.getTime() + 3_600_000),
    durationSec: 3_600,
    totalEnergyKcal: 500,
    totalDistanceM: 10_000,
    avgHeartRate: 145,
    maxHeartRate: 170,
    elevationM: 80,
    metadata: {},
  };
}

function activity(id: number, row: StravaWorkoutRow) {
  return {
    id,
    start_date: row.startedAt.toISOString(),
    row,
  };
}

describe("syncUserStrava cursor durability", () => {
  let cursor: Date | null;
  let failExternalId: string | null;
  let workouts: Map<string, StravaWorkoutRow>;
  let backfillCompletedAt: Date | null;

  beforeEach(() => {
    vi.clearAllMocks();
    cursor = previousCursor;
    failExternalId = null;
    workouts = new Map();
    backfillCompletedAt = null;

    const rows = [
      workout("strava-1", firstStart),
      workout("strava-2", secondStart),
      workout("strava-3", thirdStart),
    ];
    mocks.getStravaConnection.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      refreshTokenCiphertext: Buffer.from("ciphertext"),
    });
    mocks.findUnique.mockImplementation(async () => ({
      stravaLastActivityAt: cursor,
    }));
    mocks.fetchActivities.mockResolvedValue(
      rows.map((row, index) => activity(index + 1, row)),
    );
    mocks.fetchActivityById.mockResolvedValue({});
    mocks.mapActivity.mockImplementation((source) => source.row);
    mocks.createManyAndReturn.mockImplementation(async ({ data }) => {
      if (data.externalId === failExternalId) {
        throw new Error("database unavailable");
      }
      if (workouts.has(data.externalId)) return [];
      workouts.set(data.externalId, data);
      return [{ id: `workout-${data.externalId}`, startedAt: data.startedAt }];
    });
    mocks.updateWorkout.mockImplementation(async ({ where, data }) => {
      const externalId = where.userId_source_externalId.externalId;
      const existing = workouts.get(externalId);
      if (!existing) throw new Error("missing workout");
      workouts.set(externalId, { ...existing, ...data });
      return { id: `workout-${externalId}` };
    });
    mocks.updateMany.mockImplementation(async ({ data }) => {
      cursor = data.stravaLastActivityAt;
      return { count: 1 };
    });
    mocks.updateUser.mockImplementation(async ({ data }) => {
      backfillCompletedAt = data.stravaBackfillCompletedAt;
      return { id: "user-1" };
    });
    mocks.recordSyncFailure.mockResolvedValue(undefined);
    mocks.recordSyncSuccess.mockResolvedValue(undefined);
  });

  it("leaves the previous cursor unchanged and rejects when a workout write fails", async () => {
    failExternalId = "strava-2";

    await expect(syncUserStrava("user-1")).rejects.toThrow(
      "database unavailable",
    );

    expect(cursor).toEqual(previousCursor);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(workouts.has("strava-3")).toBe(true);
    expect(mocks.recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        integration: "strava",
        message: "database unavailable",
      }),
    );
    expect(mocks.recordSyncSuccess).not.toHaveBeenCalled();
  });

  it("leaves the backfill watermark unchanged when a workout write fails", async () => {
    failExternalId = "strava-2";

    await expect(runStravaBackfillForUser("user-1")).rejects.toThrow(
      "database unavailable",
    );

    expect(backfillCompletedAt).toBeNull();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("advances the backfill watermark after every workout is persisted", async () => {
    await expect(runStravaBackfillForUser("user-1")).resolves.toEqual({
      imported: 3,
    });

    expect(workouts.size).toBe(3);
    expect(backfillCompletedAt).toBeInstanceOf(Date);
    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
  });

  it("advances the cursor only after every fetched workout is persisted", async () => {
    await expect(syncUserStrava("user-1")).resolves.toBe(3);

    expect(workouts.size).toBe(3);
    expect(cursor).toEqual(thirdStart);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.recordSyncSuccess).toHaveBeenCalledWith("user-1", "strava");
  });

  it("replays by external identity without creating duplicate workouts", async () => {
    await expect(syncUserStrava("user-1")).resolves.toBe(3);
    await expect(syncUserStrava("user-1")).resolves.toBe(3);

    expect(workouts.size).toBe(3);
    expect(mocks.createManyAndReturn).toHaveBeenCalledTimes(6);
    expect(mocks.updateWorkout).toHaveBeenCalledTimes(3);
    expect(cursor).toEqual(thirdStart);
  });
});
