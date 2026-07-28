import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    customMetric: { findFirst: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
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

import { GET, PATCH, DELETE } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "u", role: "USER" as const, locale: "en" },
};

const EXISTING = {
  id: "cm-1",
  userId: "user-1",
  name: "Grip strength",
  unit: "kg",
  targetLow: 10,
  targetHigh: 60,
  decimals: 1,
  description: null,
  correlationEnabled: false,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  deletedAt: null,
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/custom-metrics/cm-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function delReq(): NextRequest {
  return new NextRequest("http://localhost/api/custom-metrics/cm-1", {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("GET /api/custom-metrics/[id]", () => {
  it("returns the metric for its owner", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(
      EXISTING as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/custom-metrics/cm-1"),
      params("cm-1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string } | null };
    expect(body.data?.name).toBe("Grip strength");
  });

  it("404s a cross-user metric", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      ...EXISTING,
      userId: "other-user",
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/custom-metrics/cm-1"),
      params("cm-1"),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/custom-metrics/[id]", () => {
  it("persists an updated target window", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(
      EXISTING as never,
    );
    vi.mocked(prisma.customMetric.update).mockResolvedValue({
      ...EXISTING,
      targetLow: 20,
      targetHigh: 50,
    } as never);

    const res = await PATCH(
      patchReq({ targetLow: 20, targetHigh: 50 }),
      params("cm-1"),
    );
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.customMetric.update).mock
      .calls[0][0] as { data: Record<string, unknown> };
    expect(updateCall.data.targetLow).toBe(20);
    expect(updateCall.data.targetHigh).toBe(50);
  });

  it("persists only the explicit correlation opt-in field", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(
      EXISTING as never,
    );
    vi.mocked(prisma.customMetric.update).mockResolvedValue({
      ...EXISTING,
      correlationEnabled: true,
    } as never);

    const res = await PATCH(
      patchReq({ correlationEnabled: true }),
      params("cm-1"),
    );
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.customMetric.update).mock
      .calls[0][0] as { data: Record<string, unknown> };
    expect(updateCall.data).toEqual({ correlationEnabled: true });
  });

  it("422s an inverted partial bound update without updating", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // existing.targetHigh is 60; moving the low bound above it inverts.
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(
      EXISTING as never,
    );

    const res = await PATCH(patchReq({ targetLow: 80 }), params("cm-1"));
    expect(res.status).toBe(422);
    expect(prisma.customMetric.update).not.toHaveBeenCalled();
  });

  it("409s a rename onto another live metric", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst)
      .mockResolvedValueOnce(EXISTING as never)
      .mockResolvedValueOnce({ id: "cm-other" } as never);

    const res = await PATCH(patchReq({ name: "Other" }), params("cm-1"));
    expect(res.status).toBe(409);
    expect(prisma.customMetric.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/custom-metrics/[id]", () => {
  it("soft-deletes by stamping deletedAt", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(
      EXISTING as never,
    );
    vi.mocked(prisma.customMetric.update).mockResolvedValue(EXISTING as never);

    const res = await DELETE(delReq(), params("cm-1"));
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.customMetric.update).mock
      .calls[0][0] as { data: { deletedAt: Date } };
    expect(updateCall.data.deletedAt).toBeInstanceOf(Date);
  });

  it("404s a cross-user metric without deleting", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      ...EXISTING,
      userId: "other-user",
    } as never);

    const res = await DELETE(delReq(), params("cm-1"));
    expect(res.status).toBe(404);
    expect(prisma.customMetric.update).not.toHaveBeenCalled();
  });
});
