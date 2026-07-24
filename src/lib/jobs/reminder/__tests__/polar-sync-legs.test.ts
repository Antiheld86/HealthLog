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
  syncUserPolar.mockResolvedValue(0);
  syncUserPolarWorkouts.mockResolvedValue(0);
});

describe("syncUserPolarLegs — composite independence on the shared polar ledger", () => {
  it("runs both legs and returns the summed count when both pass", async () => {
    syncUserPolar.mockResolvedValue(5);
    syncUserPolarWorkouts.mockResolvedValue(2);
    await expect(syncUserPolarLegs("u1")).resolves.toBe(7);
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
    syncUserPolar.mockResolvedValue(4);
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
