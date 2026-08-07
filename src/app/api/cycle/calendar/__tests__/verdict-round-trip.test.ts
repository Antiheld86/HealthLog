/**
 * `GET /api/cycle/calendar` — the resolved verdict actually reaches a client.
 *
 * Both ends of a payload field can be written correctly and the wire can still
 * carry nothing; this repo has shipped exactly that. So nothing here is
 * hand-built downstream of the route: the test seeds rows, calls the REAL
 * exported `GET`, reads the response body as text, parses it, and asserts on
 * what came back. The engine, the calendar builder, the verdict resolver, the
 * DTO mapping and the envelope all run for real.
 *
 * The scenario is the one that froze a cycle ring: several long observed
 * cycles push the predicted next start weeks into the future, so every day of
 * the gap carries a phase label and the raw count walks past the profile's
 * typical length. The verdict must stop counting and say how late the period
 * is — resolved against the USER's timezone day, not the process's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    menstrualCycle: { findMany: vi.fn() },
    cycleDayLog: { findMany: vi.fn() },
    measurement: { findMany: vi.fn() },
    // Present so a re-introduced forecast persist is VISIBLE here rather
    // than blowing up on an undefined model. `persistPredictionCache` calls
    // `findUnique` synchronously before its first await, so even the old
    // fire-and-forget `void persistPredictionCache(...)` lands on this mock
    // before the assertion runs.
    cyclePrediction: { findUnique: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/cycle/gate", () => ({ requireCycleEnabled: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { phaseForDate } from "@/lib/cycle/engine-adapter";
import { resolveLuteal } from "@/lib/cycle/prediction";
import { addDays } from "@/lib/cycle/day-math";

/** A user in UTC+14, so their calendar day runs ahead of the process's. */
const AHEAD_TZ = "Pacific/Kiritimati";

function session(timezone: string) {
  return {
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
    user: {
      id: "user-1",
      username: "tester",
      role: "USER" as const,
      gender: "FEMALE",
      timezone,
      locale: "en",
    },
  };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    goal: "GENERAL_HEALTH",
    // What the person says their cycle usually is. The observed cycles below
    // are much longer, which is what drives the prediction past today.
    typicalCycleLength: 28,
    typicalPeriodLength: 5,
    lutealPhaseLength: 14,
    predictionEnabled: true,
    rawChartMode: false,
    secondarySymptom: "MUCUS",
    cycleTrackingEnabled: true,
    ...overrides,
  };
}

/** Four period starts 60 days apart; the last one is still open. */
const LONG_CYCLE_STARTS = [
  "2025-11-01",
  "2025-12-31",
  "2026-03-01",
  "2026-04-30",
];

/**
 * Four period starts exactly 28 days apart — the textbook regular record. The
 * last start is open, so where "today" sits relative to `lastStart + 28`
 * decides what the verdict may claim. Built from a supplied last start so a
 * test can place today a chosen number of days past the predicted one.
 */
function regularStarts(lastStart: string): string[] {
  return [-84, -56, -28, 0].map((offset) => addDays(lastStart, offset));
}

function cycleRows(starts: readonly string[]) {
  return starts.map((startDate, i) => ({
    id: `cyc-${i}`,
    userId: "user-1",
    startDate,
    endDate: null,
    periodEndDate: null,
    ovulationDate: null,
    ovulationConfirmed: false,
    isPredicted: false,
  }));
}

async function callCalendar(): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await GET(new NextRequest("http://localhost/api/cycle/calendar"));
  // Read the WIRE, not the handler's return value.
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(session(AHEAD_TZ) as never);
  vi.mocked(requireCycleEnabled).mockResolvedValue({
    enabled: true,
    profile: profile(),
  } as never);
  vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue(
    cycleRows(LONG_CYCLE_STARTS) as never,
  );
  vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/cycle/calendar is a read", () => {
  it("persists no forecast — the reminder cron's row is the job's, not this route's", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));

    const { status, body } = await callCalendar();
    expect(status).toBe(200);
    // There IS a forecast to persist, so the absence of a write is a
    // decision rather than an empty case.
    expect((body.data as Record<string, unknown>).prediction).not.toBeNull();

    expect(prisma.cyclePrediction.findUnique).not.toHaveBeenCalled();
    expect(prisma.cyclePrediction.upsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/cycle/calendar carries the resolved verdict", () => {
  it("puts the whole verdict on the wire", async () => {
    // 2026-06-10 12:00 UTC is already 2026-06-11 for a user at UTC+14.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));

    const { status, body } = await callCalendar();
    expect(status).toBe(200);

    const data = body.data as Record<string, unknown>;
    expect(data).toHaveProperty("verdict");
    const verdict = data.verdict as Record<string, unknown>;

    // Every field the contract promises, present on the response itself.
    expect(Object.keys(verdict).sort()).toEqual([
      "cycleLength",
      "cycleStartDate",
      "dayOfCycle",
      "daysUntilNext",
      "fertileWindow",
      "overdueDays",
      "phase",
      "spans",
      "state",
    ]);
  });

  it("resolves the overdue judgement in the USER's timezone, with the day count", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));

    const { body } = await callCalendar();
    const verdict = (body.data as Record<string, unknown>).verdict as Record<
      string,
      unknown
    >;

    // The user's day is 2026-06-11: 43 days into a cycle that opened on
    // 2026-04-30, past their stated 28-day typical plus the grace window. The
    // count stops and the delay is stated: 43 − 28 = 15.
    expect(verdict.state).toBe("OVERDUE");
    expect(verdict.dayOfCycle).toBeNull();
    expect(verdict.phase).toBeNull();
    expect(verdict.overdueDays).toBe(15);
    // The last logged period start survives the ceiling — the BBT chart scopes
    // to it and the ring still draws four arcs.
    expect(verdict.cycleStartDate).toBe("2026-04-30");
    expect(verdict.spans).toHaveLength(4);
  });

  it("reads one day earlier for the same instant in UTC — the zone decides", async () => {
    // Same wall-clock instant, a user whose day has not rolled over yet. If
    // the route resolved `today` from the process instead of the account, this
    // case and the one above could not differ.
    vi.mocked(getSession).mockResolvedValue(session("UTC") as never);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));

    const { body } = await callCalendar();
    const verdict = (body.data as Record<string, unknown>).verdict as Record<
      string,
      unknown
    >;

    expect(verdict.state).toBe("IN_CYCLE");
    expect(verdict.dayOfCycle).toBe(42);
    expect(verdict.overdueDays).toBeNull();
  });

  it("agrees with the phase engine the coach read uses", async () => {
    // Two independent server derivations of one number: the ring counts the
    // labelled run, the coach/MCP block asks the phase engine directly. They
    // must not be able to tell a person two different cycle days.
    vi.mocked(getSession).mockResolvedValue(session("UTC") as never);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));

    const { body } = await callCalendar();
    const data = body.data as Record<string, unknown>;
    const verdict = data.verdict as Record<string, unknown>;
    const prediction = data.prediction as { nextPeriodStart: string } | null;

    expect(verdict.state).toBe("IN_CYCLE");

    const fromEngine = phaseForDate(
      "2026-05-20",
      cycleRows(LONG_CYCLE_STARTS) as never,
      prediction?.nextPeriodStart ?? null,
      resolveLuteal(profile() as never),
      "2026-05-20",
    );
    expect(verdict.dayOfCycle).toBe(fromEngine.dayOfCycle);
    expect(verdict.phase).toBe(fromEngine.phase);
  });

  it("counts the days to the next predicted period", async () => {
    vi.mocked(getSession).mockResolvedValue(session("UTC") as never);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));

    const { body } = await callCalendar();
    const data = body.data as Record<string, unknown>;
    const verdict = data.verdict as Record<string, unknown>;
    const prediction = data.prediction as { nextPeriodStart: string } | null;

    expect(prediction).not.toBeNull();
    const expected = Math.round(
      (Date.parse(`${prediction!.nextPeriodStart}T12:00:00Z`) -
        Date.parse("2026-05-20T12:00:00Z")) /
        86_400_000,
    );
    expect(verdict.daysUntilNext).toBe(expected);
    expect(verdict.daysUntilNext).toBeGreaterThan(0);
    // Sanity: the predicted start really is ahead of today.
    expect(prediction!.nextPeriodStart).toBe(addDays("2026-05-20", expected));
  });

  /**
   * D-list edge 1 — the verdict at and after the predicted start day, driven
   * through the real route.
   *
   * A regular 28-day record whose period has not arrived is the ORDINARY way
   * to be late, and it is the case the ring was silent about: the engine ends
   * the open cycle's phase window at the predicted start, so the day after it
   * carried no phase, and the verdict resolver read "no phase today" as "no
   * data at all". The person saw an empty ring and the words insufficient data
   * on the third day of a late period. `OVERDUE` was only ever reachable when
   * the engine itself forecast a cycle longer than the grace window.
   */
  describe("a period that has not arrived", () => {
    /** Place today N days past `lastStart + 28`, the predicted next start. */
    function overdueBy(days: number): { today: string; lastStart: string } {
      const today = "2026-06-11";
      return { today, lastStart: addDays(today, -(28 + days)) };
    }

    function seedRegular(lastStart: string): void {
      vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue(
        cycleRows(regularStarts(lastStart)) as never,
      );
    }

    it("keeps counting the open cycle past the predicted start", async () => {
      const { today, lastStart } = overdueBy(3);
      seedRegular(lastStart);
      vi.mocked(getSession).mockResolvedValue(session("UTC") as never);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(`${today}T12:00:00Z`));

      const { body } = await callCalendar();
      const data = body.data as Record<string, unknown>;
      const verdict = data.verdict as Record<string, unknown>;
      const prediction = data.prediction as { nextPeriodStart: string } | null;

      // The predicted start really is behind us — otherwise this asserts nothing.
      expect(prediction?.nextPeriodStart).toBe(addDays(today, -3));

      expect(verdict.state).toBe("IN_CYCLE");
      expect(verdict.dayOfCycle).toBe(32);
      expect(verdict.phase).toBe("LUTEAL");
      expect(verdict.cycleStartDate).toBe(lastStart);
      // There is no "until" once the predicted start is behind us.
      expect(verdict.daysUntilNext).toBeNull();
    });

    it("says OVERDUE, with the day count, once the grace window is spent", async () => {
      // Typical 28 + 14 days of grace = 42. Day 44 is past it.
      const { today, lastStart } = overdueBy(15);
      seedRegular(lastStart);
      vi.mocked(getSession).mockResolvedValue(session("UTC") as never);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(`${today}T12:00:00Z`));

      const { body } = await callCalendar();
      const verdict = (body.data as Record<string, unknown>).verdict as Record<
        string,
        unknown
      >;

      expect(verdict.state).toBe("OVERDUE");
      expect(verdict.dayOfCycle).toBeNull();
      expect(verdict.phase).toBeNull();
      expect(verdict.overdueDays).toBe(16);
      expect(verdict.cycleStartDate).toBe(lastStart);
      expect(verdict.spans).toHaveLength(4);
    });

    it("holds the count on the predicted start day itself", async () => {
      const { today, lastStart } = overdueBy(0);
      seedRegular(lastStart);
      vi.mocked(getSession).mockResolvedValue(session("UTC") as never);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(`${today}T12:00:00Z`));

      const { body } = await callCalendar();
      const verdict = (body.data as Record<string, unknown>).verdict as Record<
        string,
        unknown
      >;

      // Day 29 of a 28-day cycle: the period is due today and has not been
      // logged, which is a cycle day, not an absence of data.
      expect(verdict.state).toBe("IN_CYCLE");
      expect(verdict.dayOfCycle).toBe(29);
      expect(verdict.daysUntilNext).toBe(0);
    });

    it("stops extending the open window once the next period is logged", async () => {
      // The same record with one more start logged four days ago: the earlier
      // cycle closes at that start and today is day 5 of the new one.
      const { today, lastStart } = overdueBy(3);
      const withNewStart = [...regularStarts(lastStart), addDays(today, -4)];
      vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue(
        cycleRows(withNewStart) as never,
      );
      vi.mocked(getSession).mockResolvedValue(session("UTC") as never);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(`${today}T12:00:00Z`));

      const { body } = await callCalendar();
      const verdict = (body.data as Record<string, unknown>).verdict as Record<
        string,
        unknown
      >;

      expect(verdict.state).toBe("IN_CYCLE");
      expect(verdict.dayOfCycle).toBe(5);
      expect(verdict.cycleStartDate).toBe(addDays(today, -4));
    });
  });

  it("says INSUFFICIENT_DATA when nothing has been logged", async () => {
    vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue([] as never);
    vi.mocked(getSession).mockResolvedValue(session("UTC") as never);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));

    const { body } = await callCalendar();
    const verdict = (body.data as Record<string, unknown>).verdict as Record<
      string,
      unknown
    >;

    expect(verdict.state).toBe("INSUFFICIENT_DATA");
    expect(verdict.dayOfCycle).toBeNull();
    expect(verdict.cycleStartDate).toBeNull();
    expect(verdict.spans).toEqual([]);
  });
});
