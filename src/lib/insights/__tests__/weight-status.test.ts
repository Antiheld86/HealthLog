import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    // v1.18.11 (P6) — the input gate probes salient inputs via groupBy +
    // moodEntry.aggregate before the heavy findMany build.
    measurement: { findMany: vi.fn(), groupBy: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn(), aggregate: vi.fn() },
    customMetric: { findMany: vi.fn() },
    // v1.11.1 — the rollup readers lazy-load the user's
    // `sourcePriorityJson` via `loadUserSourcePriority`. `null` here →
    // default rank ladders.
    user: { findUnique: vi.fn() },
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
import { generateWeightStatusForUser } from "../weight-status";

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
  // Cold rollup tier: the graded builder folds monthly/yearly from the
  // full-history `measurement.findMany` fallback the test already mocks.
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
  // v1.11.1 — null source-priority blob → default rank ladders.
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
  // v1.18.11 (P6) — input-gate probe. Default to empty groups + zero mood so
  // the fingerprint is computed but, with no cached `inputHash`, the gate
  // misses and every fixture proceeds to its normal build. Tests that
  // exercise the gate set these explicitly.
  vi.mocked(prisma.measurement.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.moodEntry.aggregate).mockResolvedValue({
    _count: { _all: 0 },
    _max: { moodLoggedAt: null },
  } as never);
  vi.mocked(prisma.customMetric.findMany).mockResolvedValue([] as never);
});

describe("generateWeightStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} weight series, not the full daily array", async () => {
    const now = new Date();
    const records: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        type: "WEIGHT",
        value: 80 + (day % 5),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generateWeightStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const weight = snapshot.weight.series;
    expect(weight).toHaveProperty("recent");
    expect(weight).toHaveProperty("weekly");
    expect(weight).toHaveProperty("monthly");
    expect(weight).toHaveProperty("yearly");
    // No raw daily array beyond the bounded recent window.
    expect(weight.recent.length).toBeLessThanOrEqual(21);
    expect(weight.recent[0]).toHaveProperty("date");
    expect(weight.recent[0]).toHaveProperty("mean");
    expect(weight.recent[0]).toHaveProperty("min");
    expect(weight.recent[0]).toHaveProperty("max");
    expect(weight.monthly[0]).toHaveProperty("month");
    expect(weight.monthly[0]).toHaveProperty("mean");
    // The whole graded series collapses 1000 daily readings to a tiny
    // bucket count.
    const total =
      weight.recent.length +
      weight.weekly.length +
      weight.monthly.length +
      weight.yearly.length;
    expect(total).toBeLessThanOrEqual(50);
  });
});

describe("generateWeightStatusForUser — timeout/error never persists", () => {
  it("serves the fallback without writing a cache row on timeout", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateWeightStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.text).toBeTruthy();
    expect(result.cached).toBe(true);
    expect(result.updatedAt).toBeNull();
    // v1.8.3 — no real assessment persisted (updatedAt stays null above),
    // but a short-TTL negative stub IS written so the read-only route does
    // not re-enqueue on every navigation while the provider is degraded.
    // The stub is a timeout marker that `readFreshStatusText` rejects.
    await Promise.resolve();
    for (const call of vi.mocked(prisma.auditLog.create).mock.calls) {
      const details = JSON.parse(
        (call[0] as { data: { details: string } }).data.details,
      );
      expect(details.timeout === true || details.model === "timeout-stub").toBe(
        true,
      );
    }
  });
});

describe("generateWeightStatusForUser — cache-read skips a stub", () => {
  it("regenerates when the only cached row is a timeout stub", async () => {
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(now);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: now,
      details: JSON.stringify({
        dateKey: todayKey,
        locale: "en",
        text: "Generic stub fallback.",
        model: "timeout-stub",
        timeout: true,
      }),
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: now },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    stubCompletion('{"summary":"Fresh real assessment."}');

    const result = await generateWeightStatusForUser("user-1", {
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh real assessment.");
    expect(result.cached).toBe(false);
  });
});

describe("generateWeightStatusForUser — content-hash gate (v1.16.8)", () => {
  it("skips the completion and refreshes the cache row when the snapshot is unchanged", async () => {
    // Fixed clock so both generator runs build the identical snapshot.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T10:00:00.000Z"));
    try {
      const now = new Date();
      const records = [
        {
          type: "WEIGHT",
          value: 82,
          measuredAt: new Date(now.getTime() - dayMs),
        },
        {
          type: "WEIGHT",
          value: 81.6,
          measuredAt: new Date(now.getTime() - 2 * dayMs),
        },
      ];
      // Fresh copy per call — the generator reverses the result array in
      // place, and a shared fixture would flip order between the two runs.
      vi.mocked(prisma.measurement.findMany).mockImplementation((async () =>
        records.map((r) => ({ ...r }))) as never);
      vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({
        createdAt: now,
      } as never);
      stubCompletion('{"summary":"First real assessment."}');

      // First run: a real generation persists the snapshot fingerprint.
      await generateWeightStatusForUser("user-1", {
        locale: "en",
        force: true,
      });
      expect(runStatusCompletion).toHaveBeenCalledTimes(1);
      const persisted = JSON.parse(
        (
          vi.mocked(prisma.auditLog.create).mock.calls[0][0] as {
            data: { details: string };
          }
        ).data.details,
      ) as { text: string; snapshotHash: string };
      expect(persisted.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

      // Second run, same data: the gate finds the matching fingerprint,
      // re-persists the same text under today's dateKey, and never calls
      // the provider — even though the run is forced.
      vi.mocked(runStatusCompletion).mockClear();
      vi.mocked(prisma.auditLog.create).mockClear();
      vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
        createdAt: now,
        details: JSON.stringify({
          // Yesterday's row — outside the same-day cache read.
          dateKey: "2026-06-09",
          locale: "en",
          text: persisted.text,
          providerType: "anthropic",
          model: "x",
          tokensUsed: 1,
          snapshotHash: persisted.snapshotHash,
        }),
      } as never);

      const result = await generateWeightStatusForUser("user-1", {
        locale: "en",
        force: true,
      });

      expect(runStatusCompletion).not.toHaveBeenCalled();
      expect(result.cached).toBe(true);
      expect(result.text).toBe(persisted.text);
      // The refresh row re-keys the payload to today.
      const refreshed = JSON.parse(
        (
          vi.mocked(prisma.auditLog.create).mock.calls[0][0] as {
            data: { details: string };
          }
        ).data.details,
      ) as { dateKey: string; snapshotHash: string };
      expect(refreshed.snapshotHash).toBe(persisted.snapshotHash);
      expect(refreshed.dateKey).not.toBe("2026-06-09");
    } finally {
      vi.useRealTimers();
    }
  });

  it("regenerates when the stored fingerprint differs from the fresh snapshot", async () => {
    const now = new Date();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: now },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: now,
      details: JSON.stringify({
        dateKey: "2026-06-09",
        locale: "en",
        text: "Older assessment.",
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
        snapshotHash: "f".repeat(64),
      }),
    } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);
    stubCompletion('{"summary":"Fresh assessment for changed data."}');

    const result = await generateWeightStatusForUser("user-1", {
      locale: "en",
      force: true,
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh assessment for changed data.");
    expect(result.cached).toBe(false);
  });
});

describe("generateWeightStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    stubCompletion(
      '{"summary":"Weight trended down 0.4 kg last week. metric:WEIGHT"}',
    );

    const result = await generateWeightStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.text).toBeTruthy();
    expect(result.text).not.toContain("metric:");
    const createCalls = vi.mocked(prisma.auditLog.create).mock.calls;
    expect(createCalls.length).toBeGreaterThan(0);
    const details = (createCalls[0][0] as { data: { details: string } }).data
      .details;
    const parsed = JSON.parse(details) as { text: string };
    expect(parsed.text).not.toContain("metric:");
  });
});
