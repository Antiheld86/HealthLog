import { beforeEach, describe, expect, it, vi } from "vitest";

const { syncUserPolar, syncUserPolarWorkouts } = vi.hoisted(() => ({
  syncUserPolar: vi.fn(),
  syncUserPolarWorkouts: vi.fn(),
}));

vi.mock("@/lib/polar/sync", () => ({
  syncUserPolar,
  // The cohort config wires `recordPolarSyncFailure` as its recorder; the legs
  // handler imports the module, so the mock must expose it too.
  recordPolarSyncFailure: vi.fn(async () => {}),
}));
vi.mock("@/lib/polar/sync-workouts", () => ({ syncUserPolarWorkouts }));

import { syncUserPolarLegs } from "../polar-sync";

beforeEach(() => {
  vi.clearAllMocks();
  syncUserPolar.mockResolvedValue({ imported: 0, failed: false });
  syncUserPolarWorkouts.mockResolvedValue(0);
});

describe("syncUserPolarLegs — composite independence on the shared polar ledger", () => {
  it("runs both legs and returns the summed count when both pass", async () => {
    syncUserPolar.mockResolvedValue({ imported: 5, failed: false });
    syncUserPolarWorkouts.mockResolvedValue(2);
    await expect(syncUserPolarLegs("u1")).resolves.toEqual({
      imported: 7,
      failed: false,
    });
    expect(syncUserPolar).toHaveBeenCalledWith("u1");
    expect(syncUserPolarWorkouts).toHaveBeenCalledWith("u1");
  });

  it("sums both counts without throwing when the vitals leg returns a partial-failure count", async () => {
    // Post-R7 the vitals leg records a partial failure INTERNALLY and RETURNS
    // its healthy-collections import count rather than throwing. The wrapper
    // must sum it with the workout leg and complete cleanly — a partial vitals
    // failure never starves the user's success accounting at the cohort level.
    syncUserPolar.mockResolvedValue({ imported: 4, failed: true });
    syncUserPolarWorkouts.mockResolvedValue(2);
    // The partial is carried, not swallowed: the wrapper completes with the
    // summed count AND says a leg did not settle, so the card cannot paint a
    // run in which four of five collections failed as a clean one.
    await expect(syncUserPolarLegs("u1")).resolves.toEqual({
      imported: 6,
      failed: true,
    });
    expect(syncUserPolar).toHaveBeenCalledWith("u1");
    expect(syncUserPolarWorkouts).toHaveBeenCalledWith("u1");
  });

  it("still attempts the workout leg when the vitals leg fails (vice-versa isolation)", async () => {
    syncUserPolar.mockRejectedValue(new Error("vitals down"));
    syncUserPolarWorkouts.mockResolvedValue(3);
    // The vitals error is rethrown (attributable), but only AFTER the workout
    // leg was attempted — a vitals failure never starves the workout leg.
    await expect(syncUserPolarLegs("u1")).rejects.toThrow("vitals down");
    expect(syncUserPolarWorkouts).toHaveBeenCalledWith("u1");
  });

  it("leaves the vitals leg's result intact when the workout leg fails", async () => {
    syncUserPolar.mockResolvedValue({ imported: 4, failed: false });
    syncUserPolarWorkouts.mockRejectedValue(new Error("workouts down"));
    // The vitals leg ran to completion (its own success already recorded on
    // the shared ledger); the workout error is surfaced without undoing it.
    await expect(syncUserPolarLegs("u1")).rejects.toThrow("workouts down");
    expect(syncUserPolar).toHaveBeenCalledWith("u1");
  });

  it("rethrows the FIRST (vitals) error when both legs fail", async () => {
    syncUserPolar.mockRejectedValue(new Error("vitals first"));
    syncUserPolarWorkouts.mockRejectedValue(new Error("workouts second"));
    await expect(syncUserPolarLegs("u1")).rejects.toThrow("vitals first");
    expect(syncUserPolarWorkouts).toHaveBeenCalledWith("u1");
  });
});
