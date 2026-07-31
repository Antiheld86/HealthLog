/**
 * v1.28 — `GET /api/nutrients` window-summary contract tests.
 *
 * Pins the read shape the settings card consumes: catalog-ordered
 * per-nutrient summaries (latest day + total, days-with-data), the
 * module gate, and the `days` query validation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    nutrientIntakeDay: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
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
import { apiError } from "@/lib/api-response";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function getReq(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/nutrients${query}`);
}

interface OverviewResponse {
  data: {
    windowDays: number;
    nutrients: Array<{
      nutrient: string;
      unit: string;
      latestDay: string;
      latestAmount: number;
      daysWithData: number;
    }>;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([] as never);
});

describe("GET /api/nutrients", () => {
  it("refuses with the 403 module.disabled envelope when the module is off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "nutrients" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "nutrients",
      }),
    });
    const res = await GET(getReq());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("module.disabled");
    expect(prisma.nutrientIntakeDay.findMany).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range days value with 422", async () => {
    for (const bad of ["0", "366", "abc"]) {
      const res = await GET(getReq(`?days=${bad}`));
      expect(res.status, `days=${bad}`).toBe(422);
    }
  });

  it("defaults to a 14-day window and returns an empty list for a fresh account", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    // `lastAttempt` is null, not absent: a fresh account has no ingest in the
    // ledger, and the empty page says "nothing yet" rather than naming a failure
    // that never happened. Kept as an exact shape check so a field cannot appear
    // on this response without someone deciding it should.
    expect(body.data).toEqual({
      windowDays: 14,
      nutrients: [],
      lastAttempt: null,
    });
  });

  it("folds rows into catalog-ordered summaries with latest day/amount and day counts", async () => {
    // Rows arrive nutrient ASC, day DESC (the route's orderBy) — the
    // fold takes the first row per nutrient as the latest.
    vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([
      { nutrient: "caffeine", unit: "mg", day: "2026-07-13", amount: 310 },
      { nutrient: "caffeine", unit: "mg", day: "2026-07-12", amount: 250 },
      { nutrient: "caffeine", unit: "mg", day: "2026-07-11", amount: 400 },
      { nutrient: "vitamin_d", unit: "ug", day: "2026-07-13", amount: 22.5 },
      { nutrient: "vitamin_d", unit: "ug", day: "2026-07-10", amount: 20 },
    ] as never);

    const res = await GET(getReq("?days=7"));
    const body = (await res.json()) as OverviewResponse;
    expect(body.data.windowDays).toBe(7);
    // Catalog order: vitamin_d (vitamins block) before caffeine (tail).
    expect(body.data.nutrients).toEqual([
      {
        nutrient: "vitamin_d",
        unit: "ug",
        latestDay: "2026-07-13",
        latestAmount: 22.5,
        daysWithData: 2,
      },
      {
        nutrient: "caffeine",
        unit: "mg",
        latestDay: "2026-07-13",
        latestAmount: 310,
        daysWithData: 3,
      },
    ]);
  });

  it("counts a multi-source day once (DATAINT M3 regression)", async () => {
    // v1.29 migration 0249 lets a day carry one row per source. A non-latest
    // day logged via both APPLE_HEALTH and MANUAL must still count as ONE
    // day, not two.
    vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([
      { nutrient: "water", unit: "ml", day: "2026-07-13", amount: 900 },
      { nutrient: "water", unit: "ml", day: "2026-07-12", amount: 600 },
      { nutrient: "water", unit: "ml", day: "2026-07-12", amount: 400 },
      { nutrient: "water", unit: "ml", day: "2026-07-11", amount: 500 },
    ] as never);

    const res = await GET(getReq("?days=7"));
    const body = (await res.json()) as OverviewResponse;
    const water = body.data.nutrients.find((n) => n.nutrient === "water");
    expect(water).toEqual({
      nutrient: "water",
      unit: "ml",
      latestDay: "2026-07-13",
      latestAmount: 900,
      // Three distinct days (13th, 12th, 11th) — the buggy version counted
      // four, since the 12th's second source row didn't match the pinned
      // `latestDay` (the 13th) and opened a phantom extra day.
      daysWithData: 3,
    });
  });

  it("scopes the query to the authenticated user and the window floor", async () => {
    await GET(getReq("?days=14"));
    expect(prisma.nutrientIntakeDay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          day: { gte: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
        }),
      }),
    );
  });
});
