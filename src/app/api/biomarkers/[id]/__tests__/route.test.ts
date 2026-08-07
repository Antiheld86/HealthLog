import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    biomarker: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    labResult: { deleteMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
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

vi.mock("@/lib/labs/biomarker-store", () => ({
  encryptContextToBytes: vi.fn(() => new Uint8Array([1])),
  decryptContextFromBytes: vi.fn(() => "ctx"),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { PUT, DELETE } from "../route";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "u", role: "USER" as const, locale: "en" },
};

const EXISTING = {
  id: "bm-1",
  userId: "user-1",
  name: "LDL",
  unit: "mg/dL",
  lowerBound: 0,
  upperBound: 100,
  panel: null,
  hidden: false,
  contextEncrypted: null,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/biomarkers/bm-1", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function delReq(): NextRequest {
  return new NextRequest("http://localhost/api/biomarkers/bm-1", {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  // v1.37.0 — the 422 breadcrumb goes through `auditLog()` and the route
  // chains `.catch()` on it; `resetAllMocks` clears the factory's resolution.
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  vi.mocked(prisma.$transaction).mockImplementation((async (
    ops: Promise<unknown>[],
  ) => Promise.all(ops)) as never);
});

describe("DELETE /api/biomarkers/[id]", () => {
  it("drops the marker and its readings in one userId-narrowed transaction", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(EXISTING as never);
    vi.mocked(prisma.labResult.deleteMany).mockResolvedValue({
      count: 3,
    } as never);
    vi.mocked(prisma.biomarker.delete).mockResolvedValue(EXISTING as never);

    const res = await DELETE(delReq(), params("bm-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean } | null };
    expect(body.data?.deleted).toBe(true);

    expect(prisma.labResult.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", biomarkerId: "bm-1" },
    });
    expect(prisma.biomarker.delete).toHaveBeenCalledWith({
      where: { id: "bm-1" },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("404s a cross-user marker without deleting anything", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue({
      ...EXISTING,
      userId: "other-user",
    } as never);

    const res = await DELETE(delReq(), params("bm-1"));
    expect(res.status).toBe(404);
    expect(prisma.labResult.deleteMany).not.toHaveBeenCalled();
    expect(prisma.biomarker.delete).not.toHaveBeenCalled();
  });
});

describe("PUT /api/biomarkers/[id] — target range", () => {
  it("persists an updated reference window", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(EXISTING as never);
    vi.mocked(prisma.biomarker.update).mockResolvedValue({
      ...EXISTING,
      lowerBound: 10,
      upperBound: 50,
    } as never);

    const res = await PUT(
      putReq({ lowerBound: 10, upperBound: 50 }),
      params("bm-1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { lowerBound: number; upperBound: number } | null;
    };
    expect(body.data?.lowerBound).toBe(10);
    expect(body.data?.upperBound).toBe(50);

    const updateCall = vi.mocked(prisma.biomarker.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data.lowerBound).toBe(10);
    expect(updateCall.data.upperBound).toBe(50);
  });

  it("422s an inverted target range without updating", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(EXISTING as never);

    const res = await PUT(
      putReq({ lowerBound: 80, upperBound: 20 }),
      params("bm-1"),
    );
    expect(res.status).toBe(422);
    expect(prisma.biomarker.update).not.toHaveBeenCalled();
  });
});
