import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `loadDailyDigest` — cache behaviour for the S11/S12 "extras" (the milestone
 * gather + the intraday-tension read). Perf finding: both re-derived from
 * scratch on every 120 s poll of every open tab, reading ~8.5k rows to
 * surface a usually-null marker. Now wrapped in one SWR cell
 * (`loadDailyDigestExtrasCached`, internal to `load-digest.ts`) under the
 * shared `analytics` bucket, so this file drives the reads its builder
 * touches (`probeRollupCoverage`, `loadIntradayPulse`) and asserts they run
 * once per cache generation, not once per request.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    integrationStatus: { findMany: vi.fn().mockResolvedValue([]) },
    measurementReminder: { findMany: vi.fn().mockResolvedValue([]) },
    coachPlan: { findMany: vi.fn().mockResolvedValue([]) },
    ecgRecording: { findFirst: vi.fn().mockResolvedValue(null) },
    dismissedPriorityItem: { findMany: vi.fn().mockResolvedValue([]) },
    personalRecord: { findMany: vi.fn().mockResolvedValue([]) },
    arrivalReaction: { findMany: vi.fn().mockResolvedValue([]) },
    encounter: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/lib/dashboard/snapshot-read", () => ({
  readDashboardSnapshotCached: vi.fn(),
}));

vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/insights/derived/baseline", () => ({
  readDayMeanSeries: vi.fn().mockResolvedValue({ points: [], source: "none" }),
}));

vi.mock("@/lib/analytics/intraday-pulse-io", () => ({
  loadIntradayPulse: vi.fn(),
}));

vi.mock("@/lib/ai/capabilities/record", () => ({
  aiCapabilityForRecord: vi.fn(),
}));

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: vi.fn(() => "a reaction line"),
}));

vi.mock("@/lib/i18n/server-translator", () => ({
  getServerTranslator: vi.fn().mockReturnValue({ t: (key: string) => key }),
}));

import type { User } from "@/generated/prisma/client";
import { loadDailyDigest } from "../load-digest";
import { readDashboardSnapshotCached } from "@/lib/dashboard/snapshot-read";
import { resolveModuleMap } from "@/lib/modules/gate";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { loadIntradayPulse } from "@/lib/analytics/intraday-pulse-io";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { prisma } from "@/lib/db";
import { aiCapabilityForRecord } from "@/lib/ai/capabilities/record";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import {
  AI_AVAILABLE,
  aiUnavailable,
} from "@/__tests__/helpers/ai-capability-fixtures";

const SNAPSHOT = {
  body: {
    layout: { enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS] },
    tiles: { lastSeenByType: {} },
    medsToday: {
      activeCount: 0,
      scheduledToday: 0,
      takenToday: 0,
      skippedToday: 0,
      nextDueAt: null,
      nextDueOverdue: false,
    },
    healthScore: null,
    briefing: null,
    briefingState: "ready",
    briefingUpdatedAt: null,
    briefingStale: false,
    briefingAi: AI_AVAILABLE,
  },
  locale: "en",
};

const USER = {
  id: "user-1",
  timezone: "Europe/Berlin",
  morningDigestRefreshedOn: null,
} as unknown as User;

const NOW = new Date("2026-07-17T09:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllCachesForTests();
  vi.mocked(readDashboardSnapshotCached).mockResolvedValue(SNAPSHOT as never);
  vi.mocked(resolveModuleMap).mockResolvedValue({} as never);
  vi.mocked(probeRollupCoverage).mockResolvedValue(new Map());
  vi.mocked(loadIntradayPulse).mockResolvedValue({ tension: null } as never);
  vi.mocked(aiCapabilityForRecord).mockResolvedValue(AI_AVAILABLE);
});

describe("loadDailyDigest — S11/S12 extras cache", () => {
  it("gathers the milestone + tension inputs once, then serves the second poll from cache", async () => {
    await loadDailyDigest(USER, NOW);
    await loadDailyDigest(USER, NOW);

    expect(probeRollupCoverage).toHaveBeenCalledTimes(1);
    expect(loadIntradayPulse).toHaveBeenCalledTimes(1);
  });

  it("runs the milestone gather and the tension read in parallel, not sequentially", async () => {
    const order: string[] = [];
    vi.mocked(probeRollupCoverage).mockImplementation(async () => {
      order.push("milestone-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("milestone-end");
      return new Map();
    });
    vi.mocked(loadIntradayPulse).mockImplementation(async () => {
      order.push("tension-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("tension-end");
      return { tension: null } as never;
    });

    await loadDailyDigest(USER, NOW);

    // Sequential awaits would read as [milestone-start, milestone-end,
    // tension-start, tension-end]. Promise.all interleaves the starts
    // before either finishes.
    expect(order.slice(0, 2).sort()).toEqual([
      "milestone-start",
      "tension-start",
    ]);
  });

  it("refreshes on the next read after a measurement write invalidates the user's cache", async () => {
    await loadDailyDigest(USER, NOW);
    expect(probeRollupCoverage).toHaveBeenCalledTimes(1);

    // A fresh sleep / vitals landing (interactive write) hard-evicts the
    // `${userId}|` prefix — the same sweep the dashboard-snapshot cell
    // already relies on.
    invalidateUserMeasurements(USER.id, { evict: true });

    await loadDailyDigest(USER, NOW);
    expect(probeRollupCoverage).toHaveBeenCalledTimes(2);
    expect(loadIntradayPulse).toHaveBeenCalledTimes(2);
  });

  it("gathers the extras even with the insights module (the AI analysis opt-out) off", async () => {
    vi.mocked(resolveModuleMap).mockResolvedValue({ insights: false } as never);

    await loadDailyDigest(USER, NOW);

    expect(probeRollupCoverage).toHaveBeenCalled();
    expect(loadIntradayPulse).toHaveBeenCalled();
  });
  it("threads the resolved hero-item visibility into composition", async () => {
    vi.mocked(readDashboardSnapshotCached).mockResolvedValueOnce({
      ...SNAPSHOT,
      body: {
        ...SNAPSHOT.body,
        layout: { enabledHeroItemKinds: [] },
        medsToday: {
          ...SNAPSHOT.body.medsToday,
          nextDueOverdue: true,
          nextDueMedicationName: "Morning dose",
        },
      },
    } as never);

    const digest = await loadDailyDigest(USER, NOW);
    expect(digest.worthALook).toEqual([]);
  });
  it("lets non-hero consumers consider a candidate hidden by the dashboard", async () => {
    vi.mocked(readDashboardSnapshotCached).mockResolvedValueOnce({
      ...SNAPSHOT,
      body: {
        ...SNAPSHOT.body,
        layout: { enabledHeroItemKinds: [] },
        medsToday: {
          ...SNAPSHOT.body.medsToday,
          nextDueOverdue: true,
          nextDueMedicationName: "Morning dose",
        },
      },
    } as never);

    const digest = await loadDailyDigest(USER, NOW, {
      enabledItemKinds: PRIORITY_ITEM_KINDS,
    });

    expect(digest.worthALook.map((item) => item.kind)).toContain("dose_window");
  });
});

describe("loadDailyDigest — AI parts", () => {
  const ARRIVAL = {
    kind: "sleep_night",
    occurredAt: new Date("2026-07-17T06:00:00.000Z"),
    arrivedAt: new Date("2026-07-17T08:55:00.000Z"),
    lineEncrypted: new Uint8Array([1, 2, 3]),
    generatedAt: new Date("2026-07-17T08:56:00.000Z"),
  };

  it("resolves the coach and reaction-line capabilities for the record and publishes them", async () => {
    const digest = await loadDailyDigest(USER, NOW);

    expect(aiCapabilityForRecord).toHaveBeenCalledWith("user-1", "coach");
    expect(aiCapabilityForRecord).toHaveBeenCalledWith(
      "user-1",
      "reactionLines",
    );
    expect(digest.ai).toEqual({
      briefing: AI_AVAILABLE,
      coach: AI_AVAILABLE,
      reactionLines: AI_AVAILABLE,
    });
  });

  it("serves the stored reaction line while the capability is available", async () => {
    vi.mocked(prisma.arrivalReaction.findMany).mockResolvedValueOnce([
      ARRIVAL,
    ] as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(digest.reactionLine).toBe("a reaction line");
  });

  it("neither decrypts nor serves a stored reaction line while the capability is unavailable", async () => {
    vi.mocked(aiCapabilityForRecord).mockImplementation(async (_id, key) =>
      key === "reactionLines" ? aiUnavailable("user_disabled") : AI_AVAILABLE,
    );
    vi.mocked(prisma.arrivalReaction.findMany).mockResolvedValueOnce([
      ARRIVAL,
    ] as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(digest.reactionLine).toBeNull();
    expect(decryptFromBytes).not.toHaveBeenCalled();
    // The marker itself is data and still drives the "just in" chip.
    expect(digest.justIn?.kind).toBe("sleep_night");
  });

  it("does not decrypt plan prose while the coach capability is unavailable", async () => {
    vi.mocked(aiCapabilityForRecord).mockImplementation(async (_id, key) =>
      key === "coach" ? aiUnavailable("operator_disabled") : AI_AVAILABLE,
    );
    vi.mocked(prisma.coachPlan.findMany).mockResolvedValueOnce([
      {
        id: "p1",
        status: "active",
        reviewDate: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        ifCueEncrypted: new Uint8Array([1]),
        thenActionEncrypted: new Uint8Array([2]),
      },
    ] as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(decryptFromBytes).not.toHaveBeenCalled();
    expect(digest.worthALook.some((i) => i.kind === "coach_checkin")).toBe(
      false,
    );
  });

  it("fails closed on the briefing when a cached body predates the published state", async () => {
    const { briefingAi: _dropped, ...older } = SNAPSHOT.body;
    vi.mocked(readDashboardSnapshotCached).mockResolvedValueOnce({
      ...SNAPSHOT,
      body: older,
    } as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(digest.ai.briefing).toEqual({
      available: false,
      reason: "check_failed",
      onDeviceAllowed: false,
    });
  });
});
