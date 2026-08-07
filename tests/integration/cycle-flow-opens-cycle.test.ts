/**
 * A period logged as flow has to count as a period.
 *
 * `MenstrualCycle` rows were only ever written by the one-tap period
 * boundary. Everything else that records bleeding — the log sheet's flow
 * chips, the bulk drain, an Apple Health export full of menstrual-flow
 * samples — wrote a `CycleDayLog` and nothing more, and the engine reads
 * cycle rows. So a person could log every period they had and the module
 * still held that none had ever happened: no cycle length, no forecast, an
 * empty chart, and an offer to log a first period. An Apple Health user who
 * never found the one-tap button had the whole module dead.
 *
 * The rule the fix applies is deliberately conservative, and these cases are
 * as much about what must NOT open a cycle as what must. Spotting does not
 * (it is as often the tail or the herald of a period as its first day), an
 * entry flagged as bleeding between periods does not, and a bleeding day
 * inside an existing cycle's plausible span does not — otherwise day three of
 * a period, or a forgotten day two, would each start a cycle of their own.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-cycle-flow-opens-integration-32-bytes-min-1234567890";
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const USER_ID = "user-cycle-flow";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

async function loginAs(userId: string): Promise<void> {
  cookieJar.clear();
  headerJar.clear();
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "cycle-flow",
      email: "cycle-flow@example.test",
      gender: "FEMALE",
    },
  });
  await loginAs(USER_ID);
});

function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Log one day through the real capture route. */
async function logDay(
  date: string,
  fields: Record<string, unknown>,
): Promise<Response> {
  const { POST } = await import("@/app/api/cycle/day-logs/route");
  return POST(
    jsonRequest("/api/cycle/day-logs", "POST", {
      date,
      loggedAt: `${date}T08:00:00.000Z`,
      ...fields,
    }),
  );
}

/** The live cycle starts, oldest first. */
async function cycleStarts(): Promise<string[]> {
  const rows = await getPrismaClient().menstrualCycle.findMany({
    where: { userId: USER_ID, deletedAt: null },
    orderBy: { startDate: "asc" },
    select: { startDate: true },
  });
  return rows.map((r) => r.startDate);
}

describe("a bleeding day opens a cycle", () => {
  it("turns the first flow entry into a cycle the engine can see", async () => {
    const res = await logDay("2026-05-04", { flow: "HEAVY" });
    expect(res.status).toBe(201);

    expect(await cycleStarts()).toEqual(["2026-05-04"]);
  });

  it("does not open a second cycle for the rest of the same period", async () => {
    await logDay("2026-05-04", { flow: "HEAVY" });
    await logDay("2026-05-05", { flow: "MEDIUM" });
    // Day three with day two missing: the gap must not read as a new period.
    await logDay("2026-05-07", { flow: "LIGHT" });

    expect(await cycleStarts()).toEqual(["2026-05-04"]);
  });

  it("opens the next cycle when the next period arrives", async () => {
    await logDay("2026-05-04", { flow: "HEAVY" });
    await logDay("2026-06-01", { flow: "HEAVY" });
    await logDay("2026-06-29", { flow: "MEDIUM" });

    expect(await cycleStarts()).toEqual([
      "2026-05-04",
      "2026-06-01",
      "2026-06-29",
    ]);
  });

  it("leaves spotting alone", async () => {
    await logDay("2026-05-04", { flow: "SPOTTING" });
    expect(await cycleStarts()).toEqual([]);
  });

  it("leaves bleeding flagged as between periods alone", async () => {
    await logDay("2026-05-04", { flow: "HEAVY" });
    await logDay("2026-05-20", {
      flow: "MEDIUM",
      intermenstrualBleeding: true,
    });

    expect(await cycleStarts()).toEqual(["2026-05-04"]);
  });

  it("leaves a day with no flow alone", async () => {
    await logDay("2026-05-04", { basalBodyTempC: 36.4 });
    expect(await cycleStarts()).toEqual([]);
  });

  it("re-anchors the neighbours of a back-dated bleed", async () => {
    // The same boundary work the one-tap start does: the inserted cycle takes
    // its end from the cycle after it, and the one before it closes.
    await logDay("2026-06-01", { flow: "HEAVY" });
    await logDay("2026-07-01", { flow: "HEAVY" });
    // Remembered later, and earlier than both.
    await logDay("2026-05-04", { flow: "HEAVY" });

    const rows = await getPrismaClient().menstrualCycle.findMany({
      where: { userId: USER_ID, deletedAt: null },
      orderBy: { startDate: "asc" },
      select: { startDate: true, endDate: true, lengthDays: true },
    });
    expect(rows).toEqual([
      { startDate: "2026-05-04", endDate: "2026-05-31", lengthDays: 28 },
      { startDate: "2026-06-01", endDate: "2026-06-30", lengthDays: 30 },
      { startDate: "2026-07-01", endDate: null, lengthDays: null },
    ]);
  });

  it("does not duplicate the cycle the one-tap start already opened", async () => {
    const { POST } = await import("@/app/api/cycle/period/route");
    await POST(
      jsonRequest("/api/cycle/period", "POST", {
        action: "start",
        date: "2026-05-04",
        loggedAt: "2026-05-04T08:00:00.000Z",
      }),
    );
    // The boundary write logs MEDIUM for the day; re-saving it richer must not
    // open a second cycle on the same date.
    await logDay("2026-05-04", { flow: "HEAVY" });

    expect(await cycleStarts()).toEqual(["2026-05-04"]);
  });

  it("opens a cycle when an edit turns a day into a bleeding day", async () => {
    await logDay("2026-05-04", { basalBodyTempC: 36.4 });
    expect(await cycleStarts()).toEqual([]);

    const dayLog = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: USER_ID, date: "2026-05-04" },
      select: { id: true },
    });
    const { PATCH } = await import("@/app/api/cycle/day-logs/[id]/route");
    const res = await PATCH(
      jsonRequest(`/api/cycle/day-logs/${dayLog.id}`, "PATCH", {
        flow: "HEAVY",
      }),
      { params: Promise.resolve({ id: dayLog.id }) },
    );
    expect(res.status).toBe(200);

    expect(await cycleStarts()).toEqual(["2026-05-04"]);
  });

  it("removes the cycle again when an edit clears the flow", async () => {
    // The inverse of the case above. A cycle that can be created by an edit
    // and not undone by one leaves the record holding a period that nothing on
    // the day says happened.
    await logDay("2026-05-04", { flow: "HEAVY" });
    await logDay("2026-06-01", { flow: "HEAVY" });
    expect(await cycleStarts()).toEqual(["2026-05-04", "2026-06-01"]);

    const dayLog = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: USER_ID, date: "2026-06-01" },
      select: { id: true },
    });
    const { PATCH } = await import("@/app/api/cycle/day-logs/[id]/route");
    await PATCH(
      jsonRequest(`/api/cycle/day-logs/${dayLog.id}`, "PATCH", { flow: null }),
      { params: Promise.resolve({ id: dayLog.id }) },
    );

    expect(await cycleStarts()).toEqual(["2026-05-04"]);
    // And the May cycle is open again, not left closed against a start that
    // no longer exists.
    const may = await getPrismaClient().menstrualCycle.findFirstOrThrow({
      where: { userId: USER_ID, startDate: "2026-05-04", deletedAt: null },
      select: { endDate: true, lengthDays: true },
    });
    expect(may).toEqual({ endDate: null, lengthDays: null });
  });

  it("gives the record a forecast and a cycle day it never had", async () => {
    // What the person actually sees. Four periods 28 days apart, logged as
    // flow and nothing else, and today inside the last one.
    const today = new Date();
    const dayKey = (offset: number): string => {
      const d = new Date(today);
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;
    };
    for (const offset of [-86, -58, -30, -2]) {
      await logDay(dayKey(offset), { flow: "HEAVY" });
    }

    const { GET } = await import("@/app/api/cycle/calendar/route");
    const res = await GET(
      new NextRequest("http://localhost/api/cycle/calendar"),
    );
    const body = JSON.parse(await res.text());

    expect(body.data.profile.cyclesObserved).toBe(3);
    expect(body.data.prediction).not.toBeNull();
    expect(body.data.verdict.state).toBe("IN_CYCLE");
    expect(body.data.verdict.dayOfCycle).toBe(3);
    expect(body.data.verdict.cycleStartDate).toBe(dayKey(-2));
  });
});
