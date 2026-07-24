/**
 * Q8 — WHOOP cycle ingest used the narrow 1 h default overlap while workout /
 * recovery / sleep use the 7-day re-score overlap. A cycle re-scored through the
 * day (or fetched just after the cursor stepped past it) then fell before the
 * incremental `start` and its final value was never re-fetched. This pins cycle
 * onto the SAME overlap the other collections use (the upsert is idempotent).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchCycles = vi.fn();

vi.mock("../client", () => ({
  fetchCycles: (...a: unknown[]) => fetchCycles(...a),
  mapCycle: () => [],
}));

const getValidToken = vi.fn();
const markResourceSynced = vi.fn();
const upsertWhoopMeasurements = vi.fn();
vi.mock("../sync-core", async () => {
  const actual =
    await vi.importActual<typeof import("../sync-core")>("../sync-core");
  return {
    ...actual,
    getValidToken: (...a: unknown[]) => getValidToken(...a),
    markResourceSynced: (...a: unknown[]) => markResourceSynced(...a),
    upsertWhoopMeasurements: (...a: unknown[]) => upsertWhoopMeasurements(...a),
  };
});

const whoopConnectionFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    whoopConnection: {
      findUnique: (...a: unknown[]) => whoopConnectionFindUnique(...a),
    },
  },
}));

import { syncUserCycle } from "../sync-cycle";
import {
  WHOOP_FULL_SYNC_ANCHOR,
  WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
} from "../sync-core";

const LAST_SYNCED = new Date("2026-06-10T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  getValidToken.mockResolvedValue({
    accessToken: "tok",
    connection: { id: "c1", whoopUserId: "w1" },
  });
  whoopConnectionFindUnique.mockResolvedValue({
    lastSyncedAt: LAST_SYNCED,
    resourceCursors: null,
  });
  markResourceSynced.mockResolvedValue(undefined);
  upsertWhoopMeasurements.mockResolvedValue(0);
  fetchCycles.mockResolvedValue([]);
});

describe("syncUserCycle — 7-day re-score overlap window", () => {
  it("fetches from lastSyncedAt minus the 7-day overlap, not 1 h", async () => {
    await syncUserCycle("user-1");

    expect(fetchCycles).toHaveBeenCalledTimes(1);
    const arg = fetchCycles.mock.calls[0]![1] as { start?: Date };
    expect(arg.start?.getTime()).toBe(
      LAST_SYNCED.getTime() - WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    );
    // A cycle still settling 6 h after the cursor is inside the fetch range;
    // under the old 1 h overlap it would be missed.
    const sixHoursBefore = LAST_SYNCED.getTime() - 6 * 60 * 60 * 1000;
    expect(arg.start!.getTime()).toBeLessThanOrEqual(sixHoursBefore);
  });

  it("fullSync anchors at the deep-history anchor, not the cursor", async () => {
    await syncUserCycle("user-1", { fullSync: true });
    const arg = fetchCycles.mock.calls[0]![1] as { start?: Date };
    expect(arg.start).toEqual(WHOOP_FULL_SYNC_ANCHOR);
  });
});
