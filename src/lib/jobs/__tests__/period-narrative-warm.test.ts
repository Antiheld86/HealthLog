import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const checkRateLimit = vi.fn();
const getAssistantFlags = vi.fn();

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));
vi.mock("@/lib/feature-flags", () => ({
  getAssistantFlags: (...a: unknown[]) => getAssistantFlags(...a),
}));
// Never reach the real generator (which imports the provider chain).
vi.mock("@/lib/insights/narrative/period-narrative-generate", () => ({
  generatePeriodNarrative: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import {
  runPeriodNarrativeWarm,
  periodsForDay,
  findNarrativeCandidates,
  PERIOD_NARRATIVE_QUEUE,
  PERIOD_NARRATIVE_CRON,
} from "../period-narrative-warm";

function makePrisma(
  users: Array<{ id: string; locale: string | null }>,
  narrativeWrites: Array<{ userId: string; updatedAt: Date }> = [],
) {
  const findMany = vi.fn().mockResolvedValue(users);
  const groupBy = vi.fn().mockResolvedValue(
    narrativeWrites.map((row) => ({
      userId: row.userId,
      _max: { updatedAt: row.updatedAt },
    })),
  );
  return {
    prisma: { user: { findMany }, insightNarrative: { groupBy } },
    findMany,
    groupBy,
  };
}

// A Monday that is also the 1st of the month — both periods warm.
const MON_FIRST = new Date("2026-06-01T03:05:00.000Z");
// A plain Tuesday mid-month — no boundary.
const TUE_MID = new Date("2026-06-02T03:05:00.000Z");
// A Monday that is not the 1st — week only.
const MON_MID = new Date("2026-06-08T03:05:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  getAssistantFlags.mockResolvedValue({
    enabled: true,
    briefing: true,
    insightStatus: true,
  });
  checkRateLimit.mockResolvedValue({ allowed: true });
});

describe("periodsForDay — boundary gate", () => {
  it("warms week on a Monday", () => {
    expect(periodsForDay(MON_MID)).toContain("week");
    expect(periodsForDay(MON_MID)).not.toContain("month");
  });
  it("warms month on the 1st", () => {
    expect(periodsForDay(MON_FIRST)).toContain("month");
  });
  it("warms nothing on a plain mid-week day", () => {
    expect(periodsForDay(TUE_MID)).toEqual([]);
  });
});

describe("findNarrativeCandidates", () => {
  it("filters coach-enabled users", async () => {
    const { prisma, findMany, groupBy } = makePrisma([
      { id: "u1", locale: "de" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findNarrativeCandidates(prisma as any, 50);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.disableCoach).toBe(false);
    expect(result).toEqual([{ id: "u1", locale: "de" }]);
    // Below the cap the ordering aggregate never runs.
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("serves never-warmed and oldest-narrative users first when the cap bites", async () => {
    const { prisma, groupBy } = makePrisma(
      [
        { id: "fresh", locale: "de" },
        { id: "stale", locale: "de" },
        { id: "never", locale: "de" },
      ],
      [
        { userId: "fresh", updatedAt: new Date("2026-06-09T05:00:00Z") },
        { userId: "stale", updatedAt: new Date("2026-05-01T05:00:00Z") },
      ],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findNarrativeCandidates(prisma as any, 2);
    expect(groupBy).toHaveBeenCalledTimes(1);
    // never-warmed first (no narrative row), then the staleest write;
    // the freshest user falls past the cap.
    expect(result.map((c) => c.id)).toEqual(["never", "stale"]);
  });
});

describe("runPeriodNarrativeWarm", () => {
  it("is a no-op on a non-boundary night (no generation)", async () => {
    const { prisma, findMany } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn();
    const result = await runPeriodNarrativeWarm(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      { now: TUE_MID, generate },
    );
    expect(result.periods).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("generates the boundary periods for each candidate, gated by budget", async () => {
    const { prisma } = makePrisma([
      { id: "u1", locale: "de" },
      { id: "u2", locale: "en" },
    ]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "openai" });
    const result = await runPeriodNarrativeWarm(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      { now: MON_FIRST, generate },
    );
    expect(result.periods.sort()).toEqual(["month", "week"]);
    // 2 users × 2 periods.
    expect(generate).toHaveBeenCalledTimes(4);
    expect(result.generated).toBe(4);
    // Budget bucket checked once per user.
    expect(checkRateLimit).toHaveBeenCalledTimes(2);
  });

  it("skips a budget-blocked user without generating", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    checkRateLimit.mockResolvedValueOnce({ allowed: false });
    const generate = vi.fn();
    const result = await runPeriodNarrativeWarm(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      { now: MON_MID, generate },
    );
    expect(result.budgetBlocked).toBe(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it("short-circuits when the briefing surface is disabled", async () => {
    getAssistantFlags.mockResolvedValueOnce({
      enabled: false,
      briefing: false,
      insightStatus: false,
    });
    const { prisma, findMany } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn();
    const result = await runPeriodNarrativeWarm(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      { now: MON_FIRST, generate },
    );
    expect(result.periods).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("queue registration", () => {
  // v1.18.1 — the period-narrative wiring moved out of the 2143-LOC
  // reminder-worker boot file into the status registrar. The dead-queue guard
  // follows the wiring there.
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, "../reminder/register-status.ts"),
    "utf8",
  );

  it("registers the queue in the allQueues createQueue loop", () => {
    const match = workerSrc.match(/const allQueues\s*=\s*\[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/\bPERIOD_NARRATIVE_QUEUE\b/);
  });

  it("schedules the cron in the schedules table (with retry policy)", () => {
    expect(workerSrc).toMatch(
      /\[\s*PERIOD_NARRATIVE_QUEUE\s*,\s*PERIOD_NARRATIVE_CRON\s*,\s*insightRetryOptions\s*\]/,
    );
  });

  it("registers a createAndWork handler for the queue", () => {
    expect(workerSrc).toMatch(
      /createAndWork[\s\S]{0,120}PERIOD_NARRATIVE_QUEUE/,
    );
  });

  it("exposes a sane queue name + nightly cron", () => {
    expect(PERIOD_NARRATIVE_QUEUE).toBe("period-narrative-warm");
    expect(PERIOD_NARRATIVE_CRON).toMatch(/^\d+\s+\d+\s+\*\s+\*\s+\*$/);
  });
});
