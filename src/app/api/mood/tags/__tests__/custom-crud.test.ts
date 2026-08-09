/**
 * v1.13.0 — custom mood-tag CRUD route guards: create cap, ownership 404 on
 * edit/delete, soft-delete vs purge, and the custom-key rejection on the
 * catalogue-hide route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  moodTag: {
    count: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  moodTagCategory: { findFirst: vi.fn() },
  moodTagHidden: { upsert: vi.fn(), deleteMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
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

import { POST } from "../custom/route";
import { PATCH, DELETE } from "../custom/[key]/route";
import { PUT } from "../[key]/hidden/route";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "t", role: "USER" as const },
};

function jsonReq(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("POST /api/mood/tags/custom", () => {
  it("creates a custom tag and returns it (custom:true, decrypted label)", async () => {
    db.moodTag.count.mockResolvedValue(3);
    db.moodTag.create.mockResolvedValue({
      key: "custom:abc",
      icon: "Heart",
      kind: "BINARY",
      scaleMin: 1,
      scaleMax: 5,
      inverse: false,
    });
    const res = await POST(
      jsonReq("http://localhost/api/mood/tags/custom", "POST", {
        label: "Date night",
        icon: "Heart",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { custom: boolean; label: string; labelKey: null; key: string };
    };
    expect(body.data).toMatchObject({
      custom: true,
      label: "Date night",
      labelKey: null,
      key: "custom:abc",
    });
    // Label is stored encrypted, never plaintext.
    expect(db.moodTag.create.mock.calls[0][0].data.labelEncrypted).toBe(
      "enc:Date night",
    );
  });

  it("rejects over the per-user cap with 422", async () => {
    db.moodTag.count.mockResolvedValue(50);
    const res = await POST(
      jsonReq("http://localhost/api/mood/tags/custom", "POST", { label: "X" }),
    );
    expect(res.status).toBe(422);
    expect(db.moodTag.create).not.toHaveBeenCalled();
  });

  it("defaults to the seeded custom category without a categoryKey (v1.13 contract)", async () => {
    db.moodTag.count.mockResolvedValue(0);
    db.moodTag.create.mockResolvedValue({
      key: "custom:x",
      icon: null,
      kind: "BINARY",
      scaleMin: 1,
      scaleMax: 5,
      inverse: false,
    });
    await POST(
      jsonReq("http://localhost/api/mood/tags/custom", "POST", { label: "X" }),
    );
    expect(db.moodTagCategory.findFirst).not.toHaveBeenCalled();
    expect(db.moodTag.create.mock.calls[0][0].data.categoryId).toBe(
      "mtc_custom",
    );
  });

  it("resolves categoryKey to a seeded OR own group (v1.17.0) and 422s an unknown one", async () => {
    db.moodTag.count.mockResolvedValue(0);
    db.moodTagCategory.findFirst.mockResolvedValue({ id: "cg1" });
    db.moodTag.create.mockResolvedValue({
      key: "custom:x",
      icon: null,
      kind: "BINARY",
      scaleMin: 1,
      scaleMax: 5,
      inverse: false,
    });
    const ok = await POST(
      jsonReq("http://localhost/api/mood/tags/custom", "POST", {
        label: "X",
        categoryKey: "customcat:g1",
      }),
    );
    expect(ok.status).toBe(201);
    expect(db.moodTag.create.mock.calls[0][0].data.categoryId).toBe("cg1");
    // Resolution is owner-scoped: seeded (userId null) OR the caller's own.
    const catWhere = db.moodTagCategory.findFirst.mock.calls[0][0].where;
    expect(catWhere).toEqual({
      key: "customcat:g1",
      isActive: true,
      OR: [{ userId: null }, { userId: "user-1" }],
    });

    db.moodTagCategory.findFirst.mockResolvedValue(null);
    const bad = await POST(
      jsonReq("http://localhost/api/mood/tags/custom", "POST", {
        label: "X",
        categoryKey: "customcat:theirs",
      }),
    );
    expect(bad.status).toBe(422);
  });
});

describe("PATCH/DELETE /api/mood/tags/custom/:key", () => {
  const params = (key: string) => ({ params: Promise.resolve({ key }) });

  it("404s when the key is not the caller's own custom tag", async () => {
    db.moodTag.findFirst.mockResolvedValue(null);
    const res = await PATCH(
      jsonReq("http://localhost/api/mood/tags/custom/custom:x", "PATCH", {
        isActive: false,
      }),
      params("custom:x"),
    );
    expect(res.status).toBe(404);
  });

  it("404s a non-custom key without touching the DB", async () => {
    const res = await DELETE(
      new NextRequest("http://localhost/api/mood/tags/custom/happy"),
      params("happy"),
    );
    expect(res.status).toBe(404);
    expect(db.moodTag.findFirst).not.toHaveBeenCalled();
  });

  it("moves a custom tag to another group via categoryKey (v1.17.0)", async () => {
    db.moodTag.findFirst.mockResolvedValue({ id: "id1" });
    db.moodTagCategory.findFirst.mockResolvedValue({ id: "cg1" });
    db.moodTag.update.mockResolvedValue({
      key: "custom:x",
      icon: null,
      kind: "BINARY",
      scaleMin: 1,
      scaleMax: 5,
      inverse: false,
      isActive: true,
      labelEncrypted: "enc:X",
    });
    const res = await PATCH(
      jsonReq("http://localhost/api/mood/tags/custom/custom:x", "PATCH", {
        categoryKey: "customcat:g1",
      }),
      params("custom:x"),
    );
    expect(res.status).toBe(200);
    expect(db.moodTag.update.mock.calls[0][0].data).toEqual({
      categoryId: "cg1",
    });
  });

  it("422s a move to an unknown / foreign group without writing", async () => {
    db.moodTag.findFirst.mockResolvedValue({ id: "id1" });
    db.moodTagCategory.findFirst.mockResolvedValue(null);
    const res = await PATCH(
      jsonReq("http://localhost/api/mood/tags/custom/custom:x", "PATCH", {
        categoryKey: "ghost",
      }),
      params("custom:x"),
    );
    expect(res.status).toBe(422);
    expect(db.moodTag.update).not.toHaveBeenCalled();
  });

  it("soft-deactivates by default and hard-deletes on ?purge=true", async () => {
    db.moodTag.findFirst.mockResolvedValue({ id: "id1" });
    const soft = await DELETE(
      new NextRequest("http://localhost/api/mood/tags/custom/custom:abc"),
      params("custom:abc"),
    );
    expect(soft.status).toBe(200);
    expect(db.moodTag.update).toHaveBeenCalledWith({
      where: { id: "id1" },
      data: { isActive: false },
    });
    expect(db.moodTag.delete).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    db.moodTag.findFirst.mockResolvedValue({ id: "id1" });
    const purge = await DELETE(
      new NextRequest(
        "http://localhost/api/mood/tags/custom/custom:abc?purge=true",
      ),
      params("custom:abc"),
    );
    expect(purge.status).toBe(200);
    expect(db.moodTag.delete).toHaveBeenCalledWith({ where: { id: "id1" } });
    // A purge cascades `mood_entry_tag_links` and unpicks history, so it must
    // leave a ledger row recording that it happened.
    expect(vi.mocked(auditLog)).toHaveBeenCalledWith(
      "mood.tag.custom.delete",
      expect.objectContaining({
        details: expect.objectContaining({ purge: true }),
      }),
    );
  });
});

describe("PUT /api/mood/tags/:key/hidden", () => {
  it("rejects a custom key with 400 (custom tags hide via isActive)", async () => {
    const res = await PUT(
      jsonReq("http://localhost/api/mood/tags/custom:abc/hidden", "PUT", {
        hidden: true,
      }),
      { params: Promise.resolve({ key: "custom:abc" }) },
    );
    expect(res.status).toBe(400);
  });

  it("upserts a hide row for a catalogue tag", async () => {
    db.moodTag.findFirst.mockResolvedValue({ id: "t_sad" });
    const res = await PUT(
      jsonReq("http://localhost/api/mood/tags/sad/hidden", "PUT", {
        hidden: true,
      }),
      { params: Promise.resolve({ key: "sad" }) },
    );
    expect(res.status).toBe(200);
    expect(db.moodTagHidden.upsert).toHaveBeenCalled();
  });
});
