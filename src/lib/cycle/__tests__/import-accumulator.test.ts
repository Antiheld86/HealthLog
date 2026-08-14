/**
 * Cycle-import accumulator — flush fault isolation (A6).
 *
 * The pre-fix flush let one colliding day throw out of the loop; the
 * importer's catch then zeroed the stats, so a partial write reported
 * `samplesConsumed: 0` over rows already in the table. The flush is now
 * fault-isolated per day and its stats stay honest: what landed counts,
 * what failed is named.
 *
 * Watched red: with the per-day try/catch removed from `flush()` the
 * partial-failure test throws instead of reporting
 * `{ daysUpserted: 1, daysFailed: 1 }`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findManyCycles: vi.fn(async () => []),
  findUniqueProfile: vi.fn(async () => null),
  updateManyProfile: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    menstrualCycle: { findMany: mocks.findManyCycles },
    cycleProfile: {
      findUnique: mocks.findUniqueProfile,
      updateMany: mocks.updateManyProfile,
    },
  },
}));
vi.mock("@/lib/cycle/day-log-write", () => ({
  upsertCycleDayLog: (...args: unknown[]) => mocks.upsert(...args),
}));
vi.mock("@/lib/cycle/gate", () => ({
  isCycleAvailableForUser: vi.fn(async () => true),
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));

import { CycleImportAccumulator } from "../import-accumulator";

const FLOW = "HKCategoryTypeIdentifierMenstrualFlow";

beforeEach(() => {
  mocks.upsert.mockReset();
});

describe("CycleImportAccumulator.flush — per-day fault isolation", () => {
  it("keeps counting after a failed day and names the failure", async () => {
    const acc = new CycleImportAccumulator("u1", "Europe/Berlin");
    expect(
      acc.consume(FLOW, "2026-05-10", "HKCategoryValueMenstrualFlowMedium"),
    ).toBe(true);
    expect(
      acc.consume(FLOW, "2026-05-11", "HKCategoryValueMenstrualFlowLight"),
    ).toBe(true);

    mocks.upsert
      .mockRejectedValueOnce(new Error("colliding day"))
      .mockResolvedValueOnce({ existed: false });

    const stats = await acc.flush();

    expect(stats.samplesConsumed).toBe(2);
    expect(stats.daysUpserted).toBe(1);
    expect(stats.daysInserted).toBe(1);
    expect(stats.daysFailed).toBe(1);
    expect(stats.firstFailureReason).toBe("colliding day");
  });

  it("reports clean stats when every day lands", async () => {
    const acc = new CycleImportAccumulator("u1", "Europe/Berlin");
    acc.consume(FLOW, "2026-05-10", "3");
    mocks.upsert.mockResolvedValue({ existed: false });

    const stats = await acc.flush();
    expect(stats).toMatchObject({
      samplesConsumed: 1,
      daysUpserted: 1,
      daysFailed: 0,
      firstFailureReason: null,
      samplesSkippedModuleDisabled: 0,
    });
  });
});
