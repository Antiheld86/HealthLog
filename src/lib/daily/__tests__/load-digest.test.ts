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

  it("never gathers the extras when the insights module is disabled", async () => {
    vi.mocked(resolveModuleMap).mockResolvedValue({ insights: false } as never);

    await loadDailyDigest(USER, NOW);

    expect(probeRollupCoverage).not.toHaveBeenCalled();
    expect(loadIntradayPulse).not.toHaveBeenCalled();
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
