import { describe, expect, it, vi, beforeEach } from "vitest";

// The graded series folds per-day aggregates in SQL; the fake folds the
// mocked `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    // v1.28.25 — the graded-series cold-tier fallback day-buckets dense
    // types (PULSE) via a raw aggregate instead of a full findMany walk.
    $queryRaw: vi.fn(async () => []),
    moodEntry: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
  // Consent never blocks in these fixtures — the gate has its own tests.
  statusConsentBlocksGeneration: vi.fn(async () => false),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { generatePulseStatusForUser } from "../pulse-status";

const dayMs = 24 * 60 * 60 * 1000;

function stubCompletion(
  content: string,
  capture?: { userPrompt: string | null },
) {
  vi.mocked(runStatusCompletion).mockImplementation(
    async (args: { userPrompt: string }) => {
      if (capture) capture.userPrompt = args.userPrompt;
      return {
        kind: "ok",
        content,
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
      } as never;
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  // Cold rollup tier: the pulse graded series folds monthly/yearly from
  // the full-history `measurement.findMany` fallback on a tier miss.
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
});

describe("generatePulseStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} pulse series, not the full daily array", async () => {
    const now = new Date();
    const records: Array<{ value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        value: 70 + (day % 8),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    // v1.28.25 — PULSE is a dense type, so the cold-tier fallback reads
    // a SQL day-bucket aggregate instead of the raw findMany walk. Feed
    // the same 1000 days as day buckets.
    vi.mocked(prisma.$queryRaw).mockResolvedValue(
      records
        .map((r) => ({ bucket_start: r.measuredAt, mean: r.value }))
        .reverse() as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generatePulseStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const pulse = snapshot.pulse.series;
    expect(pulse).toHaveProperty("recent");
    expect(pulse).toHaveProperty("weekly");
    expect(pulse).toHaveProperty("monthly");
    expect(pulse).toHaveProperty("yearly");
    expect(pulse.recent.length).toBeLessThanOrEqual(21);
    expect(pulse.recent[0]).toHaveProperty("date");
    expect(pulse.recent[0]).toHaveProperty("mean");
    expect(pulse.monthly[0]).toHaveProperty("month");
    const total =
      pulse.recent.length +
      pulse.weekly.length +
      pulse.monthly.length +
      pulse.yearly.length;
    expect(total).toBeLessThanOrEqual(50);
  });
});

describe("generatePulseStatusForUser — A2 resting-target in-target %", () => {
  it("scores RESTING_HEART_RATE against the resting band, ignoring workout PULSE", async () => {
    const now = new Date();
    // PULSE polluted with a heavy workout burst (would tank the in-target
    // % if scored against the resting band).
    const pulseRecords: Array<{ value: number; measuredAt: Date }> = [];
    for (let i = 0; i < 500; i++) {
      pulseRecords.push({
        value: 150,
        measuredAt: new Date(now.getTime() - (i % 30) * dayMs),
      });
    }
    // Clean resting series, comfortably inside a 60-100 band, covering the
    // SAME 30-day span as the PULSE above. The span has to match for the
    // fixture to mean what the test name claims: the resolver merges per
    // day, so a day with no resting row of its own is estimated from that
    // day's PULSE rather than dropped. Leaving ten of the thirty days
    // resting-free made this assert the merge's gap-fill behaviour by
    // accident — on days whose only readings are a 150 bpm workout, the
    // honest estimate IS out of band. Gap-day behaviour is pinned directly
    // in `resting-pulse.test.ts`; this case is about preferring the clean
    // signal over workout HR where both exist.
    const restingRecords: Array<{ value: number; measuredAt: Date }> = [];
    for (let d = 0; d < 30; d++) {
      restingRecords.push({
        value: 72,
        measuredAt: new Date(now.getTime() - d * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    // pulse-status reads PULSE first, then RESTING_HEART_RATE.
    vi.mocked(prisma.measurement.findMany)
      .mockResolvedValueOnce(pulseRecords as never)
      .mockResolvedValueOnce(restingRecords as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generatePulseStatusForUser("user-resting", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);
    // Resting 72 sits inside the 60-100 band → 100 % in target, NOT the
    // ~0 % the workout-polluted PULSE stream would have produced.
    expect(snapshot.pulse.target.inTargetPctLast30DailyPoints).toBe(100);
  });

  it("falls back to a low-percentile PULSE proxy when no resting rows exist", async () => {
    const now = new Date();
    // Each day: mostly resting reads ~72 + a workout burst ~150. The
    // proxy's low percentile should keep most days in-band.
    const pulseRecords: Array<{ value: number; measuredAt: Date }> = [];
    for (let d = 0; d < 10; d++) {
      const dayStart = new Date(now.getTime() - d * dayMs);
      for (let i = 0; i < 20; i++) {
        pulseRecords.push({
          value: 70 + (i % 10),
          measuredAt: new Date(dayStart.getTime() - i * 60_000),
        });
      }
      for (let i = 0; i < 5; i++) {
        pulseRecords.push({
          value: 150,
          measuredAt: new Date(dayStart.getTime() - (i + 30) * 60_000),
        });
      }
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany)
      .mockResolvedValueOnce(pulseRecords as never)
      .mockResolvedValueOnce([] as never); // no RESTING_HEART_RATE
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generatePulseStatusForUser("user-proxy", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);
    // The proxy excludes the workout burst → the resting estimate stays
    // in the healthy band, so the in-target % is high, not tanked to ~0.
    expect(
      snapshot.pulse.target.inTargetPctLast30DailyPoints,
    ).toBeGreaterThanOrEqual(80);
  });
});

describe("generatePulseStatusForUser — per-user tz (QA F5)", () => {
  it("rolls the cache over at the USER's own midnight, not Berlin's", async () => {
    // A moment that is already "tomorrow" in Berlin (UTC+2 summer) but still
    // "today" in New York (UTC-4 summer). Before the fix, `todayKey` was
    // computed from `toBerlinDayKey(new Date())` BEFORE the user's profile
    // (and its timezone) was even read.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T23:30:00.000Z")); // Berlin: 06-21 01:30
    const nyToday = "2026-06-20"; // New York: 06-20 19:30
    try {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        dateOfBirth: null,
        gender: null,
        timezone: "America/New_York",
      } as never);
      vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
        createdAt: new Date(),
        details: JSON.stringify({
          dateKey: nyToday,
          locale: "en",
          text: "NY-anchored cached pulse text.",
          model: "x",
        }),
      } as never);

      const result = await generatePulseStatusForUser("user-ny", {
        locale: "en",
      });

      // If the day-key were still Berlin-pinned, this NY-dated row would
      // MISS (today in Berlin is 06-21) and a real generation would run.
      expect(result.cached).toBe(true);
      expect(result.text).toBe("NY-anchored cached pulse text.");
      expect(runStatusCompletion).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("generatePulseStatusForUser — cache-read skips a stub", () => {
  it("regenerates when the only cached row is a timeout stub", async () => {
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(now);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: now,
      details: JSON.stringify({
        dateKey: todayKey,
        locale: "en",
        text: "Pulse fallback text…",
        model: "timeout-stub",
        timeout: true,
      }),
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 72, measuredAt: now },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    stubCompletion('{"summary":"Fresh pulse assessment."}');

    const result = await generatePulseStatusForUser("user-1", { locale: "en" });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh pulse assessment.");
    expect(result.cached).toBe(false);
  });
});

describe("generatePulseStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 72, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    stubCompletion(
      '{"summary":"Your pulse is stable. metric:PULSE The 7-day average sits inside the band."}',
    );

    const result = await generatePulseStatusForUser("user-1", { locale: "en" });

    expect(result.text).toBeTruthy();
    expect(result.text).not.toContain("metric:");
    const createCalls = vi.mocked(prisma.auditLog.create).mock.calls;
    expect(createCalls.length).toBeGreaterThan(0);
    const details = (createCalls[0][0] as { data: { details: string } }).data
      .details;
    const parsed = JSON.parse(details) as { text: string };
    expect(parsed.text).not.toContain("metric:");
    expect(parsed.text).toContain("Your pulse is stable.");
  });
});
