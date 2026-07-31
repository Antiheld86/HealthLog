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

// Always allow the anti-spam bucket so the surface gate is what the test
// exercises.
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

// Stub the worker enqueue so the route test stays isolated from pg-boss.
vi.mock("@/lib/jobs/insight-pregenerate-shared", () => ({
  enqueueForceWarm: vi.fn(async () => undefined),
}));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { enqueueForceWarm } from "@/lib/jobs/insight-pregenerate-shared";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

const callPost = POST as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest(new URL("http://localhost/api/insights/pregenerate"), {
    method: "POST",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
});

describe("POST /api/insights/pregenerate", () => {
  it("enqueues a warm when insightStatus is enabled", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callPost(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { queued: boolean } | null;
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(body.data?.queued).toBe(true);
    expect(enqueueForceWarm).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("gates on insightStatus, not coach — a coach-disabled user can still warm", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      assistantEnabled: true,
      assistantCoachEnabled: false,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
    } as never);
    const res = await callPost(makeReq());
    expect(res.status).toBe(200);
    expect(enqueueForceWarm).toHaveBeenCalledTimes(1);
  });

  it("403s + errorCode when insightStatus is disabled", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: false,
      assistantCorrelationsEnabled: true,
    } as never);
    const res = await callPost(makeReq());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("assistant.disabled.insightStatus");
    expect(enqueueForceWarm).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callPost(makeReq());
    expect(res.status).toBe(401);
    expect(enqueueForceWarm).not.toHaveBeenCalled();
  });
});
