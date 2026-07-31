import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// v1.18.0 — the route now resolves the `insights` module gate after
// `requireAuth()`. Mock it default-enabled so the existing assertions
// ride through; the off → 403 coverage lives in the route-gate inventory
// test.
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

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

// Stub the heavy generator so the gate test stays isolated from the
// real status pipeline.
vi.mock("@/lib/insights/blood-pressure-status", () => ({
  generateBloodPressureStatusForUser: vi.fn(async () => ({
    available: true,
    locale: "en",
    text: "ok",
  })),
  resolveBloodPressureStatusLocale: () => "en",
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { apiError } from "@/lib/api-response";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/insights/blood-pressure-status");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
});

describe("GET /api/insights/blood-pressure-status — assistant-flag gate", () => {
  it("returns 200 when insightStatus is enabled (default)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
  });

  it("returns 403 + errorCode when insightStatus is off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: false,
      assistantCorrelationsEnabled: true,
    } as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("assistant.disabled.insightStatus");
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
  });
});

// v1.18.0 (B2) — the route now also requires the `insights` module.
// Representative coverage that a disabled module short-circuits with the
// 403 module.disabled envelope before any provider / cache work; the
// inventory test guards that EVERY insights AI route carries this gate.
describe("GET /api/insights/blood-pressure-status — insights module gate", () => {
  it("returns 200 when insights is enabled (default)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
  });

  it("returns 403 + module.disabled when insights is off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(requireModuleEnabled).mockResolvedValueOnce({
      enabled: false,
      response: apiError('Module "insights" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "insights",
      }),
    });
    const res = await callGet(makeReq());
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      meta?: { errorCode?: string; module?: string };
    };
    expect(body.meta?.errorCode).toBe("module.disabled");
    expect(body.meta?.module).toBe("insights");
  });
});
