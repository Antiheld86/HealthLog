/**
 * The nightly achievement-unlock sweep.
 *
 * This is where the `UserAchievement` rows are written now that
 * `GET /api/gamification/achievements` is a pure read. Two things have to
 * hold: the rows actually get written (a sweep that persists nothing is the
 * silent half of a two-ended change), and the module gate the route applied
 * still applies here — a badge whose owning module is off must never be
 * pinned just because nobody is watching the read path any more.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: vi.fn() },
    userAchievement: { createMany: vi.fn() },
  },
}));

vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: vi.fn(async () => ({})),
}));

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (evt: { addMeta: () => void }) => Promise<unknown>,
  ) => fn({ addMeta: () => {} }),
}));

import { prisma } from "@/lib/db";
import { resolveModuleMap } from "@/lib/modules/gate";
import {
  runAchievementUnlockSweep,
  handleAchievementUnlockSweep,
} from "@/lib/jobs/achievement-unlock-sweep";

const USERS = [
  { id: "user-1", timezone: "Europe/Berlin" },
  { id: "user-2", timezone: "Europe/Berlin" },
];

function resultWith(ids: string[]) {
  return {
    pendingUnlocks: ids.map((achievementId) => ({
      achievementId,
      unlockedAt: new Date("2026-07-04T10:00:00.000Z"),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findMany).mockResolvedValue(USERS as never);
  vi.mocked(prisma.userAchievement.createMany).mockResolvedValue({
    count: 1,
  } as never);
});

describe("achievement-unlock-sweep", () => {
  it("pins every unpinned unlock it finds", async () => {
    const summary = await runAchievementUnlockSweep({
      resolveModules: (async () => ({})) as never,
      buildResult: (async () => resultWith(["mood-first"])) as never,
    });

    expect(summary.scanned).toBe(2);
    // The count is the point: an empty sweep would satisfy "no duplicates"
    // just as well as a working one.
    expect(vi.mocked(prisma.userAchievement.createMany)).toHaveBeenCalledTimes(
      2,
    );
    expect(summary.persisted).toBe(2);
    expect(vi.mocked(prisma.userAchievement.createMany)).toHaveBeenCalledWith({
      data: [
        {
          userId: "user-1",
          achievementId: "mood-first",
          unlockedAt: new Date("2026-07-04T10:00:00.000Z"),
        },
      ],
      skipDuplicates: true,
    });
  });

  it("writes nothing for an account with the achievements module off", async () => {
    const summary = await runAchievementUnlockSweep({
      resolveModules: (async () => ({ achievements: false })) as never,
      buildResult: (async () => resultWith(["mood-first"])) as never,
    });

    expect(summary.skipped).toBe(2);
    expect(summary.persisted).toBe(0);
    expect(vi.mocked(prisma.userAchievement.createMany)).not.toHaveBeenCalled();
  });

  it("keeps sweeping after one account throws and counts the failure", async () => {
    let call = 0;
    const summary = await runAchievementUnlockSweep({
      resolveModules: (async () => ({})) as never,
      buildResult: (async () => {
        call += 1;
        if (call === 1) throw new Error("evaluation blew up");
        return resultWith(["mood-first"]);
      }) as never,
    });

    expect(summary.failed).toBe(1);
    expect(summary.persisted).toBe(1);
    expect(vi.mocked(prisma.userAchievement.createMany)).toHaveBeenCalledTimes(
      1,
    );
  });

  it("fails the job when every account failed", async () => {
    // A fault that hits every account (a dead pool, a schema drift) is
    // systemic and must reach the operator's failing-jobs surface rather
    // than pass quietly with a zero count.
    vi.mocked(prisma.user.findMany).mockResolvedValue([USERS[0]] as never);
    vi.mocked(resolveModuleMap).mockRejectedValue(new Error("pool gone"));

    const outcome = await handleAchievementUnlockSweep([]);
    expect(outcome.ok).toBe(false);
  });

  it("succeeds when there was simply nothing to pin", async () => {
    const summary = await runAchievementUnlockSweep({
      resolveModules: (async () => ({})) as never,
      buildResult: (async () => resultWith([])) as never,
    });
    expect(summary.persisted).toBe(0);
    expect(summary.failed).toBe(0);
    expect(vi.mocked(prisma.userAchievement.createMany)).not.toHaveBeenCalled();
  });
});
