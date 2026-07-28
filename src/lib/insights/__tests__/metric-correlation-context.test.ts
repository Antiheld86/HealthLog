import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    illnessEpisode: { findMany: vi.fn() },
    illnessDayLog: { findMany: vi.fn() },
    environmentContext: { findMany: vi.fn() },
    customMetric: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/correlation-patterns", () => ({
  PATTERN_FAMILIES: { discoveryRetrospective: "DISCOVERY_RETROSPECTIVE" },
  syncAcceptedPatterns: vi.fn().mockResolvedValue(new Map()),
  decisionForEvidence: vi.fn().mockReturnValue(null),
}));

import { prisma } from "@/lib/db";
import { getRelevantCorrelationsForMetric } from "../metric-correlation-context";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    timezone: "Europe/Berlin",
  } as never);
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.illnessDayLog.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.environmentContext.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.customMetric.findMany).mockResolvedValue([] as never);
});

describe("getRelevantCorrelationsForMetric", () => {
  it("returns [] without any DB read for a non-discovery metric", async () => {
    // VO2_MAX is not part of the curated discovery matrix.
    const out = await getRelevantCorrelationsForMetric("u-1", "VO2_MAX");
    expect(out).toEqual([]);
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  it("surfaces only FDR-surviving pairs that involve the metric's channel", async () => {
    // Build two strongly-correlated daily series over 60 days:
    //   TIME_IN_DAYLIGHT (behaviour) → next-day RESTING_HEART_RATE (outcome),
    // anti-correlated, plus uncorrelated noise on other channels.
    const rows: Array<{ type: string; value: number; measuredAt: Date }> = [];
    const base = new Date("2026-01-01T12:00:00Z");
    for (let d = 0; d < 60; d++) {
      const day = new Date(base.getTime() + d * 86_400_000);
      const daylight = 30 + (d % 10) * 6; // varies 30..84
      rows.push({ type: "TIME_IN_DAYLIGHT", value: daylight, measuredAt: day });
      // next-day RHR moves opposite to today's daylight (lag-1 anti-corr).
      const next = new Date(base.getTime() + (d + 1) * 86_400_000);
      rows.push({
        type: "RESTING_HEART_RATE",
        value: 90 - daylight * 0.4,
        measuredAt: next,
      });
    }
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(rows as never);

    const out = await getRelevantCorrelationsForMetric(
      "u-1",
      "RESTING_HEART_RATE",
    );
    expect(out.length).toBeGreaterThan(0);
    // Every surfaced relation mentions resting heart rate (the metric's channel).
    for (const c of out) {
      expect(c.interpretation.toLowerCase()).toContain("resting heart rate");
      expect(Number.isFinite(c.r)).toBe(true);
      expect(c.n).toBeGreaterThanOrEqual(20);
    }
  });

  it("is best-effort: a DB failure resolves to [] rather than throwing", async () => {
    vi.mocked(prisma.measurement.findMany).mockRejectedValue(
      new Error("db down"),
    );
    const out = await getRelevantCorrelationsForMetric(
      "u-1",
      "RESTING_HEART_RATE",
    );
    expect(out).toEqual([]);
  });
});
