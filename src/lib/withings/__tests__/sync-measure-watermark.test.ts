/**
 * v1.28.39 F4 — Withings measure-sync watermark-hold contract.
 *
 * The documented status-tracking contract (see `syncUserMeasurements`) says a
 * downstream measurement-upsert failure must record a sync failure rather than
 * silently advancing the watermark. Pre-fix, `lastSyncedAt` + `recordSyncSuccess`
 * were stamped UNCONDITIONALLY after a warn-only per-row loop, so a transient
 * per-row write failure stranded that reading forever behind the 10-minute
 * overlap window. These tests pin the fix: a hard row failure HOLDS the
 * watermark (no stamp, no success, records a failure) so the next tick retries;
 * a benign P2002 idempotent-write collision does NOT hold it; a clean run stamps
 * as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    withingsConnection: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => v),
  encrypt: vi.fn((v: string) => v),
}));

vi.mock("../client", () => ({
  fetchMeasurements: vi.fn(),
  refreshAccessToken: vi.fn(),
  subscribeWebhook: vi.fn(),
}));

vi.mock("../credentials", () => ({
  getUserWithingsCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "secret",
  })),
}));

vi.mock("@/lib/integrations/status", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/integrations/status")
  >("@/lib/integrations/status");
  return {
    ...actual,
    isReauthRequired: vi.fn().mockResolvedValue(false),
    recordSyncFailure: vi.fn().mockResolvedValue(undefined),
    recordSyncSuccess: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    ...actual,
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
  invalidateUserMeasurements: vi.fn(),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: vi.fn(() => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
  })),
  annotate: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { fetchMeasurements, refreshAccessToken } from "../client";
import {
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";

import { getValidToken, syncUserMeasurements } from "../sync";

const P2002 = Object.assign(new Error("Unique constraint failed"), {
  code: "P2002",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation(async (run) =>
    run(prisma as never),
  );
  // A live, non-expired connection so `getValidToken` returns the token
  // without touching the refresh path.
  vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
    id: "conn-1",
    withingsUserId: "wu-1",
    accessToken: "enc-access",
    refreshToken: "enc-refresh",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000),
  } as never);
  vi.mocked(prisma.withingsConnection.update).mockResolvedValue({} as never);
  vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);
  vi.mocked(prisma.measurement.update).mockResolvedValue({} as never);
});

describe("getValidToken — serialized rotating refresh", () => {
  it("re-reads token state under an advisory lock and reuses a peer winner", async () => {
    vi.mocked(prisma.withingsConnection.findUnique)
      .mockResolvedValueOnce({
        id: "conn-1",
        withingsUserId: "wu-1",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        tokenExpiresAt: new Date(Date.now() - 1000),
      } as never)
      .mockResolvedValueOnce({
        id: "conn-1",
        withingsUserId: "wu-1",
        accessToken: "winner-access",
        refreshToken: "winner-refresh",
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      } as never);

    const result = await getValidToken("user-1");

    expect(result?.accessToken).toBe("winner-access");
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxWait: expect.any(Number),
        timeout: expect.any(Number),
      }),
    );
  });
});

describe("syncUserMeasurements — watermark hold on hard row failure (F4)", () => {
  it("holds lastSyncedAt and records a failure when a row hard-fails", async () => {
    vi.mocked(fetchMeasurements).mockResolvedValue([
      {
        type: "WEIGHT",
        value: 80,
        measuredAt: new Date("2026-05-16T08:00:00Z"),
      },
      {
        type: "PULSE",
        value: 60,
        measuredAt: new Date("2026-05-16T08:05:00Z"),
      },
    ] as never);
    // The first write hard-fails (a transient DB error), the second succeeds.
    vi.mocked(prisma.measurement.create)
      .mockRejectedValueOnce(new Error("connection reset by peer"))
      .mockResolvedValue({} as never);

    const result = await syncUserMeasurements("user-1");

    // Only the second row persisted, and the caller is told the run lost one.
    expect(result).toEqual({ imported: 1, failed: true });
    // The watermark is HELD — no stamp — so the next tick refetches the window.
    expect(prisma.withingsConnection.update).not.toHaveBeenCalled();
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    // The failure is recorded so the streak + admin threshold reflect it.
    expect(recordSyncFailure).toHaveBeenCalledTimes(1);
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", integration: "withings" }),
    );
  });

  it("does NOT hold the watermark for a benign P2002 idempotent-write collision", async () => {
    vi.mocked(fetchMeasurements).mockResolvedValue([
      {
        type: "WEIGHT",
        value: 80,
        measuredAt: new Date("2026-05-16T08:00:00Z"),
      },
    ] as never);
    vi.mocked(prisma.measurement.create).mockRejectedValueOnce(P2002);

    const { imported } = await syncUserMeasurements("user-1");

    // P2002 means the row is already present — nothing lost — so the cycle is
    // still healthy: stamp the watermark + success, record no failure.
    expect(imported).toBe(0);
    expect(prisma.withingsConnection.update).toHaveBeenCalledTimes(1);
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings", {
      leg: "measures",
    });
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("stamps the watermark + success on a clean run", async () => {
    vi.mocked(fetchMeasurements).mockResolvedValue([
      {
        type: "WEIGHT",
        value: 80,
        measuredAt: new Date("2026-05-16T08:00:00Z"),
      },
    ] as never);

    const { imported } = await syncUserMeasurements("user-1");

    expect(imported).toBe(1);
    expect(prisma.withingsConnection.update).toHaveBeenCalledTimes(1);
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings", {
      leg: "measures",
    });
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  // Watched red: with the `invalidateUserMeasurements(userId)` call removed
  // from the sync tail this fails — the pre-fix tail evicted only the
  // dashboard snapshot, so correlations / analytics / targets / derived
  // served pre-sync bodies until their TTL lapsed after every hourly sync
  // (the correlations route documents the invariant this restores).
  it("marks the per-user measurement caches stale when rows landed", async () => {
    vi.mocked(fetchMeasurements).mockResolvedValue([
      {
        type: "WEIGHT",
        value: 80,
        measuredAt: new Date("2026-05-16T08:00:00Z"),
      },
    ] as never);

    await syncUserMeasurements("user-1");

    const { invalidateUserMeasurements } =
      await import("@/lib/cache/invalidate");
    expect(vi.mocked(invalidateUserMeasurements)).toHaveBeenCalledWith(
      "user-1",
    );
  });
});
