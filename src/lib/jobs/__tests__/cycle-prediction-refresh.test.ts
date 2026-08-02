/**
 * The nightly cycle-forecast refresh.
 *
 * `CyclePrediction` is the row the cycle-reminder cron scans, and this job is
 * its only writer now that `GET /api/cycle/calendar` is a pure read. The
 * property that matters is that the forecast for an account that never opens
 * the calendar still gets written — the failure this replaces was silent in
 * both directions (a write on a read, and a discarded promise that hid the
 * failure).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { cycleProfile: { findMany: vi.fn() } },
}));

vi.mock("@/lib/cycle/gate", () => ({
  isCycleAvailableForUser: vi.fn(async () => true),
}));

vi.mock("@/lib/cycle/prediction-refresh", () => ({
  refreshPredictionCacheForUser: vi.fn(async () => "persisted"),
}));

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (evt: { addMeta: () => void }) => Promise<unknown>,
  ) => fn({ addMeta: () => {} }),
}));

import { prisma } from "@/lib/db";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { refreshPredictionCacheForUser } from "@/lib/cycle/prediction-refresh";
import {
  runCyclePredictionRefresh,
  handleCyclePredictionRefresh,
} from "@/lib/jobs/cycle-prediction-refresh";

const NOW = new Date("2026-07-30T02:20:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.cycleProfile.findMany).mockResolvedValue([
    { userId: "user-1" },
    { userId: "user-2" },
  ] as never);
  vi.mocked(isCycleAvailableForUser).mockResolvedValue(true);
  vi.mocked(refreshPredictionCacheForUser).mockResolvedValue("persisted");
});

describe("cycle-prediction-refresh", () => {
  it("refreshes every tracking account, opened calendar or not", async () => {
    const summary = await runCyclePredictionRefresh(NOW);

    expect(summary.scanned).toBe(2);
    // The count is the point: a cohort query that matched nothing would
    // satisfy "no bad writes" just as well as a working sweep.
    expect(vi.mocked(refreshPredictionCacheForUser)).toHaveBeenCalledTimes(2);
    expect(summary.refreshed).toBe(2);
    expect(vi.mocked(refreshPredictionCacheForUser)).toHaveBeenCalledWith(
      "user-1",
      NOW,
    );
  });

  it("skips an account whose cycle module is off", async () => {
    vi.mocked(isCycleAvailableForUser).mockResolvedValue(false);

    const summary = await runCyclePredictionRefresh(NOW);

    expect(summary.skipped).toBe(2);
    expect(summary.refreshed).toBe(0);
    expect(vi.mocked(refreshPredictionCacheForUser)).not.toHaveBeenCalled();
  });

  it("counts an account whose refresh throws and carries on", async () => {
    vi.mocked(refreshPredictionCacheForUser)
      .mockRejectedValueOnce(new Error("bad rows"))
      .mockResolvedValueOnce("persisted");

    const summary = await runCyclePredictionRefresh(NOW);

    expect(summary.failed).toBe(1);
    expect(summary.refreshed).toBe(1);
  });

  it("fails the job when every account failed", async () => {
    // Systemic, not one account's data — it belongs on the operator's
    // failing-jobs surface rather than passing quietly.
    vi.mocked(prisma.cycleProfile.findMany).mockResolvedValue([
      { userId: "user-1" },
    ] as never);
    vi.mocked(refreshPredictionCacheForUser).mockRejectedValue(
      new Error("pool gone"),
    );

    const outcome = await handleCyclePredictionRefresh([]);
    expect(outcome.ok).toBe(false);
  });

  it("succeeds when no account tracks a cycle", async () => {
    vi.mocked(prisma.cycleProfile.findMany).mockResolvedValue([] as never);

    const outcome = await handleCyclePredictionRefresh([]);
    expect(outcome.ok).toBe(true);
  });
});
