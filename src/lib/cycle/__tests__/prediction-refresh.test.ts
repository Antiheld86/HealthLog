/**
 * `refreshPredictionCacheForUser` — the request-free recompute the nightly
 * job runs.
 *
 * Two things are load-bearing. It has to reach the persistence at all (the
 * job's whole purpose is that a forecast exists for an account that never
 * opened the calendar), and the write's failure has to escape: the previous
 * implementation caught everything and returned, so a cache that had not been
 * written for weeks looked exactly like one with nothing to write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    cycleProfile: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    menstrualCycle: { findMany: vi.fn() },
    cycleDayLog: { findMany: vi.fn() },
    measurement: { findMany: vi.fn() },
    cyclePrediction: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { refreshPredictionCacheForUser } from "@/lib/cycle/prediction-refresh";

const NOW = new Date("2026-06-10T02:20:00.000Z");

function profile(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    goal: "GENERAL_HEALTH",
    typicalCycleLength: 28,
    typicalPeriodLength: 5,
    lutealPhaseLength: 14,
    predictionEnabled: true,
    rawChartMode: false,
    secondarySymptom: "MUCUS",
    cycleTrackingEnabled: true,
    ...overrides,
  };
}

/** Four period starts 28 days apart, the last one still open. */
const CYCLE_STARTS = ["2026-03-05", "2026-04-02", "2026-04-30", "2026-05-28"];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(
    profile() as never,
  );
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    timezone: "Europe/Berlin",
  } as never);
  vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue(
    CYCLE_STARTS.map((startDate, i) => ({
      id: `cyc-${i}`,
      userId: "user-1",
      startDate,
      endDate: null,
      periodEndDate: null,
      ovulationDate: null,
      ovulationConfirmed: false,
    })) as never,
  );
  vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.cyclePrediction.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.cyclePrediction.upsert).mockResolvedValue({} as never);
});

describe("refreshPredictionCacheForUser", () => {
  it("writes the forecast for an account that never opened the calendar", async () => {
    const outcome = await refreshPredictionCacheForUser("user-1", NOW);

    expect(outcome).toBe("persisted");
    expect(prisma.cyclePrediction.upsert).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.cyclePrediction.upsert).mock.calls[0]![0] as {
      where: { userId: string };
      create: { nextPeriodStart: string; generatedAt: Date };
    };
    expect(call.where.userId).toBe("user-1");
    // A real forecast, not a placeholder: four 28-day cycles put the next
    // period start 28 days after the last one.
    expect(call.create.nextPeriodStart).toBe("2026-06-25");
    expect(call.create.generatedAt).toEqual(NOW);
  });

  it("writes nothing for an account with prediction turned off", async () => {
    vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(
      profile({ predictionEnabled: false }) as never,
    );

    const outcome = await refreshPredictionCacheForUser("user-1", NOW);

    expect(outcome).toBe("no-prediction");
    expect(prisma.cyclePrediction.upsert).not.toHaveBeenCalled();
  });

  it("writes nothing for an account that has no cycle profile", async () => {
    vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(null as never);

    const outcome = await refreshPredictionCacheForUser("user-1", NOW);

    expect(outcome).toBe("no-profile");
    expect(prisma.cyclePrediction.upsert).not.toHaveBeenCalled();
  });

  it("lets a failed write escape instead of swallowing it", async () => {
    vi.mocked(prisma.cyclePrediction.upsert).mockRejectedValue(
      new Error("write rejected"),
    );

    await expect(
      refreshPredictionCacheForUser("user-1", NOW),
    ).rejects.toThrowError("write rejected");
  });
});
