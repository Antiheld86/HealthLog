import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { aggregate: vi.fn() },
    workout: { aggregate: vi.fn() },
  },
}));

import { getAppleHealthSyncProgress } from "../apple-health-progress";
import { prisma } from "@/lib/db";

function mockAggregates(
  measurement: { count: number; min: Date | null },
  workout: { count: number; min: Date | null },
) {
  vi.mocked(prisma.measurement.aggregate).mockResolvedValue({
    _count: { _all: measurement.count },
    _min: { measuredAt: measurement.min },
  } as never);
  vi.mocked(prisma.workout.aggregate).mockResolvedValue({
    _count: { _all: workout.count },
    _min: { startedAt: workout.min },
  } as never);
}

describe("getAppleHealthSyncProgress", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sums measurement and workout rows into one accepted count", async () => {
    mockAggregates(
      { count: 1200, min: new Date("2019-03-01T08:00:00.000Z") },
      { count: 45, min: new Date("2021-06-01T06:30:00.000Z") },
    );

    const progress = await getAppleHealthSyncProgress("user-1");

    expect(progress.recordsAccepted).toBe(1245);
  });

  it("reports the oldest instant across both tables", async () => {
    mockAggregates(
      { count: 10, min: new Date("2020-01-05T00:00:00.000Z") },
      { count: 3, min: new Date("2018-11-20T07:15:00.000Z") },
    );

    const progress = await getAppleHealthSyncProgress("user-1");

    expect(progress.oldestMeasuredAt).toBe("2018-11-20T07:15:00.000Z");
  });

  it("uses the measurement minimum when workouts have no rows", async () => {
    mockAggregates(
      { count: 8, min: new Date("2022-02-02T12:00:00.000Z") },
      {
        count: 0,
        min: null,
      },
    );

    const progress = await getAppleHealthSyncProgress("user-1");

    expect(progress.recordsAccepted).toBe(8);
    expect(progress.oldestMeasuredAt).toBe("2022-02-02T12:00:00.000Z");
  });

  it("is honest about a source that has delivered nothing", async () => {
    mockAggregates({ count: 0, min: null }, { count: 0, min: null });

    const progress = await getAppleHealthSyncProgress("user-1");

    expect(progress).toEqual({ recordsAccepted: 0, oldestMeasuredAt: null });
  });

  it("scopes both reads to the user and the APPLE_HEALTH source", async () => {
    mockAggregates({ count: 0, min: null }, { count: 0, min: null });

    await getAppleHealthSyncProgress("user-9");

    expect(prisma.measurement.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-9", deletedAt: null, source: "APPLE_HEALTH" },
      }),
    );
    expect(prisma.workout.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-9", source: "APPLE_HEALTH" },
      }),
    );
  });
});
