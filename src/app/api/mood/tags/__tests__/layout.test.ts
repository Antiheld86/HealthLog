/**
 * v1.17.0 — `GET/PUT /api/mood/tags/layout`: resolved groupOrder over the
 * effective category set, preserve-when-absent merge on PUT, and the Zod
 * bounds on the blob.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  moodTagCategory: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  prisma: db,
  toJson: <T>(v: T) => v,
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

import { GET, PUT } from "../layout/route";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "t", role: "USER" as const },
};

const CATEGORY_KEYS = [
  { key: "feelings" },
  { key: "custom" },
  { key: "customcat:g1" },
];

function putReq(body: unknown) {
  return new NextRequest("http://localhost/api/mood/tags/layout", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  db.moodTagCategory.findMany.mockResolvedValue(CATEGORY_KEYS);
  db.user.findUnique.mockResolvedValue({ moodTagLayoutJson: null });
});

describe("GET /api/mood/tags/layout", () => {
  it("returns seeded defaults when nothing is stored", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { groupOrder: string[]; placements: Record<string, string[]> };
    };
    expect(body.data).toEqual({
      groupOrder: ["feelings", "custom", "customcat:g1"],
      placements: {},
    });
  });

  it("resolves the stored order: layout first, unknown dropped, missing appended", async () => {
    db.user.findUnique.mockResolvedValue({
      moodTagLayoutJson: {
        groupOrder: ["customcat:g1", "ghost", "feelings"],
        placements: { "customcat:g1": ["happy"] },
      },
    });
    const res = await GET();
    const body = (await res.json()) as {
      data: { groupOrder: string[]; placements: Record<string, string[]> };
    };
    expect(body.data.groupOrder).toEqual([
      "customcat:g1",
      "feelings",
      "custom",
    ]);
    expect(body.data.placements).toEqual({ "customcat:g1": ["happy"] });
  });
});

describe("PUT /api/mood/tags/layout", () => {
  it("merges preserve-when-absent: a groupOrder-only PUT keeps stored placements", async () => {
    db.user.findUnique.mockResolvedValue({
      moodTagLayoutJson: { placements: { feelings: ["sad"] } },
    });
    const res = await PUT(putReq({ groupOrder: ["custom", "feelings"] }));
    expect(res.status).toBe(200);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      // v1.32.22 (M2) — tokenless write echoes the fresh `updatedAt` token.
      select: { updatedAt: true },
      data: {
        moodTagLayoutJson: {
          groupOrder: ["custom", "feelings"],
          placements: { feelings: ["sad"] },
        },
      },
    });
    const body = (await res.json()) as {
      data: { groupOrder: string[]; placements: Record<string, string[]> };
    };
    expect(body.data.groupOrder).toEqual([
      "custom",
      "feelings",
      "customcat:g1",
    ]);
    expect(body.data.placements).toEqual({ feelings: ["sad"] });
  });

  it("422s an over-bound blob without writing", async () => {
    const res = await PUT(
      putReq({ groupOrder: Array.from({ length: 51 }, (_, i) => `g${i}`) }),
    );
    expect(res.status).toBe(422);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("422s a malformed body (non-array groupOrder)", async () => {
    const res = await PUT(putReq({ groupOrder: "feelings" }));
    expect(res.status).toBe(422);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
