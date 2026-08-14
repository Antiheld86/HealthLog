/**
 * Integration coverage for the v1.24 MCP write + range read against a real
 * Postgres testcontainer + Prisma client (not mocks):
 *
 *   - `logMcpBloodPressure` writes BOTH the systolic and diastolic rows
 *     atomically with one shared `externalId` namespace and one `measuredAt`,
 *     is idempotent on a replay, and refuses an implausible / out-of-range pair
 *     without persisting anything.
 *   - the rich-read explicit `{from,to}` date range reads the rollup tier the
 *     trailing windows use and filters to the requested span — exercised end to
 *     end through `compareMetric` (which seeds real DAY rollups via the measure
 *     write core).
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { logMcpBloodPressure, logMcpMeasurement } from "@/lib/mcp/writes";
import { compareMetric } from "@/lib/mcp/rich-reads";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import type { McpAuthContext } from "@/lib/mcp/auth";

import { getPrismaClient, truncateAllTables } from "./setup";

function readCtx(userId: string): McpAuthContext {
  return {
    userId,
    tokenId: "token-int",
    scopes: ["health:read"],
    binding: `${userId}:token-int`,
    canRead: true,
    canWrite: false,
  };
}

function readTool(name: string) {
  const def = MCP_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function makeUser(suffix: string) {
  return getPrismaClient().user.create({
    data: {
      username: `mcp-${suffix}`,
      email: `mcp-${suffix}@example.test`,
    },
  });
}

describe("logMcpBloodPressure — real DB", () => {
  it("writes paired SYS + DIA rows atomically with one externalId + timestamp", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("bp");

    const result = await logMcpBloodPressure({
      userId: user.id,
      systolic: 122,
      diastolic: 78,
      idempotencyKey: "bp-key-1",
    });
    expect(result.status).toBe("written");

    const sys = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
    });
    const dia = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
    });
    expect(sys).toHaveLength(1);
    expect(dia).toHaveLength(1);
    expect(sys[0].value).toBe(122);
    expect(dia[0].value).toBe(78);
    expect(sys[0].source).toBe("MCP");
    expect(dia[0].source).toBe("MCP");
    expect(sys[0].unit).toBe("mmHg");
    // Shared idempotency namespace + identical measuredAt.
    expect(sys[0].externalId).toBe(dia[0].externalId);
    expect(sys[0].externalId).toMatch(/^mcp:bp:/);
    expect(sys[0].measuredAt.getTime()).toBe(dia[0].measuredAt.getTime());
  });

  it("is idempotent — a replay with the same key writes no duplicate rows", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("bp-replay");

    await logMcpBloodPressure({
      userId: user.id,
      systolic: 120,
      diastolic: 80,
      idempotencyKey: "bp-key-2",
    });
    const replay = await logMcpBloodPressure({
      userId: user.id,
      systolic: 120,
      diastolic: 80,
      idempotencyKey: "bp-key-2",
    });
    expect(replay.status).toBe("already_logged");

    const count = await prisma.measurement.count({
      where: { userId: user.id },
    });
    expect(count).toBe(2); // still just the one SYS + one DIA
  });

  it("refuses an implausible pair (systolic ≤ diastolic) and persists nothing", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("bp-bad");

    const result = await logMcpBloodPressure({
      userId: user.id,
      systolic: 80,
      diastolic: 120,
      idempotencyKey: "bp-key-3",
    });
    expect(result.status).toBe("out_of_range");
    expect(await prisma.measurement.count({ where: { userId: user.id } })).toBe(
      0,
    );
  });
});

describe("measuredAt instant bound — real DB", () => {
  it("refuses a far-future / ancient measuredAt and persists nothing (measurement + BP)", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("instant");

    const future = await logMcpMeasurement({
      userId: user.id,
      type: "WEIGHT",
      value: 80,
      measuredAt: new Date("9999-01-01T00:00:00Z"),
      idempotencyKey: "instant-future",
    });
    expect(future.status).toBe("out_of_range");

    const ancient = await logMcpMeasurement({
      userId: user.id,
      type: "WEIGHT",
      value: 80,
      measuredAt: new Date("1000-01-01T00:00:00Z"),
      idempotencyKey: "instant-ancient",
    });
    expect(ancient.status).toBe("out_of_range");

    const bpFuture = await logMcpBloodPressure({
      userId: user.id,
      systolic: 120,
      diastolic: 80,
      measuredAt: new Date("9999-01-01T00:00:00Z"),
      idempotencyKey: "instant-bp-future",
    });
    expect(bpFuture.status).toBe("out_of_range");

    expect(await prisma.measurement.count({ where: { userId: user.id } })).toBe(
      0,
    );
  });

  it("accepts a now-ish measuredAt", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("instant-ok");

    const result = await logMcpMeasurement({
      userId: user.id,
      type: "WEIGHT",
      value: 80,
      measuredAt: new Date(),
      idempotencyKey: "instant-now",
    });
    expect(result.status).toBe("written");
    expect(await prisma.measurement.count({ where: { userId: user.id } })).toBe(
      1,
    );
  });
});

describe("get_preventive_care — real DB", () => {
  it("surfaces the user's configured reminders with overdue flags, {present:false} when none", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("vorsorge");

    const empty = (await readTool("get_preventive_care").run(
      readCtx(user.id),
      {},
    )) as { present: boolean };
    expect(empty.present).toBe(false);

    await prisma.measurementReminder.create({
      data: {
        userId: user.id,
        label: "Blood pressure check",
        measurementType: "BLOOD_PRESSURE_SYS",
        intervalDays: 30,
        notifyHour: 9,
        enabled: true,
        // A past due date so the read flags it overdue.
        nextDueAt: new Date("2000-01-01T00:00:00Z"),
      },
    });

    const result = (await readTool("get_preventive_care").run(
      readCtx(user.id),
      {},
    )) as {
      present: boolean;
      checkups: Array<{ label: string; overdue: boolean }>;
    };
    expect(result.present).toBe(true);
    expect(result.checkups).toHaveLength(1);
    expect(result.checkups[0]).toMatchObject({
      // The label is the user's own free text and rides the USER_TEXT fence
      // like the appointment reason beside it.
      label: "<<<USER_TEXT_START>>>Blood pressure check<<<USER_TEXT_END>>>",
      overdue: true,
    });
  });
});

describe("compareMetric — explicit {from,to} range over real rollups", () => {
  it("filters each side's buckets to its range and computes a delta", async () => {
    const user = await makeUser("range");
    const dayMs = 24 * 60 * 60 * 1000;

    // Seed weight readings on distinct recent days via the measure write core,
    // which recomputes the DAY rollups the range read consults.
    const seed = async (daysAgo: number, value: number, key: string) =>
      logMcpMeasurement({
        userId: user.id,
        type: "WEIGHT",
        value,
        measuredAt: new Date(Date.now() - daysAgo * dayMs),
        idempotencyKey: key,
      });

    // Side A window: ~30..22 days ago (mean 82). Side B: ~8..2 days ago (84).
    await seed(30, 82, "w-a1");
    await seed(26, 82, "w-a2");
    await seed(22, 82, "w-a3");
    await seed(8, 84, "w-b1");
    await seed(5, 84, "w-b2");
    await seed(2, 84, "w-b3");

    const from = new Date(Date.now() - 32 * dayMs).toISOString();
    const to = new Date(Date.now() - 20 * dayMs).toISOString();
    const fromB = new Date(Date.now() - 10 * dayMs).toISOString();
    const toB = new Date(Date.now() - 1 * dayMs).toISOString();

    const res = await compareMetric(user.id, {
      metric: "weight",
      range: { from, to },
      rangeB: { from: fromB, to: toB },
    });

    expect(res.present).toBe(true);
    expect(res.mode).toBe("window_vs_window");
    expect(res.a?.mean).toBe(82);
    expect(res.b?.mean).toBe(84);
    expect(res.a?.from).toBe(from);
    expect(res.delta?.mean).toBe(2);
  });
});
