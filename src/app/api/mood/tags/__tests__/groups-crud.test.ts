/**
 * v1.17.0 — custom mood-tag group CRUD guards: create cap, ownership 404 on
 * edit/delete, and the non-destructive delete (re-home own tags → seeded
 * `custom`, strip the group from the layout blob, soft-deactivate by default
 * vs hard-delete on ?purge=true).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => {
  const base = {
    moodTagCategory: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    moodTag: { updateMany: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  };
  // Interactive tx: hand the same mock surface to the callback.
  base.$transaction.mockImplementation(
    async (fn: (tx: typeof base) => Promise<unknown>) => fn(base),
  );
  return base;
});

vi.mock("@/lib/db", () => ({
  prisma: db,
  toJson: <T>(v: T) => v,
}));
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

import { POST } from "../groups/route";
import { PATCH, DELETE } from "../groups/[key]/route";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { CUSTOM_CATEGORY_ID } from "@/lib/mood/custom-tags";

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

const params = (key: string) => ({ params: Promise.resolve({ key }) });

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(
    async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
  );
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("POST /api/mood/tags/groups", () => {
  it("creates a group and returns it (custom:true, decrypted label)", async () => {
    db.moodTagCategory.count.mockResolvedValue(2);
    db.moodTagCategory.create.mockResolvedValue({
      key: "customcat:abc",
      icon: "Stethoscope",
    });
    const res = await POST(
      jsonReq("http://localhost/api/mood/tags/groups", "POST", {
        label: "Therapie",
        icon: "Stethoscope",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { key: string; label: string; labelKey: null; custom: boolean };
    };
    expect(body.data).toMatchObject({
      key: "customcat:abc",
      label: "Therapie",
      labelKey: null,
      custom: true,
    });
    const data = db.moodTagCategory.create.mock.calls[0][0].data;
    // Label is stored encrypted, never plaintext; owner pinned from session.
    expect(data.labelEncrypted).toBe("enc:Therapie");
    expect(data.userId).toBe("user-1");
    expect(data.key.startsWith("customcat:")).toBe(true);
  });

  it("rejects over the per-user cap with 422", async () => {
    db.moodTagCategory.count.mockResolvedValue(12);
    const res = await POST(
      jsonReq("http://localhost/api/mood/tags/groups", "POST", { label: "X" }),
    );
    expect(res.status).toBe(422);
    expect(db.moodTagCategory.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/mood/tags/groups/:key", () => {
  it("404s a seeded category key without touching the DB", async () => {
    const res = await PATCH(
      jsonReq("http://localhost/api/mood/tags/groups/feelings", "PATCH", {
        label: "x",
      }),
      params("feelings"),
    );
    expect(res.status).toBe(404);
    expect(db.moodTagCategory.findFirst).not.toHaveBeenCalled();
  });

  it("404s when the key is not the caller's own group", async () => {
    db.moodTagCategory.findFirst.mockResolvedValue(null);
    const res = await PATCH(
      jsonReq("http://localhost/api/mood/tags/groups/customcat:x", "PATCH", {
        label: "x",
      }),
      params("customcat:x"),
    );
    expect(res.status).toBe(404);
  });

  it("renames (re-encrypts) and returns the updated group", async () => {
    db.moodTagCategory.findFirst.mockResolvedValue({ id: "cg1" });
    db.moodTagCategory.update.mockResolvedValue({
      key: "customcat:x",
      icon: null,
      isActive: true,
      labelEncrypted: "enc:Neu",
    });
    const res = await PATCH(
      jsonReq("http://localhost/api/mood/tags/groups/customcat:x", "PATCH", {
        label: "Neu",
      }),
      params("customcat:x"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { label: string; isActive: boolean };
    };
    expect(body.data).toMatchObject({ label: "Neu", isActive: true });
    expect(db.moodTagCategory.update.mock.calls[0][0].data).toEqual({
      labelEncrypted: "enc:Neu",
    });
  });
});

describe("DELETE /api/mood/tags/groups/:key", () => {
  beforeEach(() => {
    db.moodTagCategory.findFirst.mockResolvedValue({ id: "cg1" });
    db.moodTag.updateMany.mockResolvedValue({ count: 2 });
    db.user.findUnique.mockResolvedValue({
      moodTagLayoutJson: {
        groupOrder: ["customcat:x", "feelings"],
        placements: { "customcat:x": ["happy"], feelings: ["sad"] },
      },
    });
  });

  it("re-homes own tags, strips the layout, soft-deactivates by default", async () => {
    const res = await DELETE(
      new NextRequest("http://localhost/api/mood/tags/groups/customcat:x"),
      params("customcat:x"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { purged: boolean; rehomedCount: number };
    };
    expect(body.data).toMatchObject({ purged: false, rehomedCount: 2 });

    // Own custom tags re-home to the seeded custom category.
    expect(db.moodTag.updateMany).toHaveBeenCalledWith({
      where: { categoryId: "cg1", userId: "user-1" },
      data: { categoryId: CUSTOM_CATEGORY_ID },
    });
    // Layout blob drops the group from order + placements, keeps the rest.
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        moodTagLayoutJson: {
          groupOrder: ["feelings"],
          placements: { feelings: ["sad"] },
        },
      },
    });
    // Default = retire, never delete.
    expect(db.moodTagCategory.update).toHaveBeenCalledWith({
      where: { id: "cg1" },
      data: { isActive: false },
    });
    expect(db.moodTagCategory.delete).not.toHaveBeenCalled();
  });

  it("hard-deletes the emptied group row on ?purge=true", async () => {
    const res = await DELETE(
      new NextRequest(
        "http://localhost/api/mood/tags/groups/customcat:x?purge=true",
      ),
      params("customcat:x"),
    );
    expect(res.status).toBe(200);
    expect(db.moodTagCategory.delete).toHaveBeenCalledWith({
      where: { id: "cg1" },
    });
    expect(db.moodTagCategory.update).not.toHaveBeenCalled();
    // Re-home still ran first — purge removes the group, never the tags.
    expect(db.moodTag.updateMany).toHaveBeenCalled();
    // A group delete/purge leaves a ledger row recording purge + re-home.
    expect(vi.mocked(auditLog)).toHaveBeenCalledWith(
      "mood.tag.group.delete",
      expect.objectContaining({
        details: expect.objectContaining({ purge: true }),
      }),
    );
  });

  it("404s a non-custom key and a foreign group", async () => {
    const seeded = await DELETE(
      new NextRequest("http://localhost/api/mood/tags/groups/custom"),
      params("custom"),
    );
    expect(seeded.status).toBe(404);

    db.moodTagCategory.findFirst.mockResolvedValue(null);
    const foreign = await DELETE(
      new NextRequest("http://localhost/api/mood/tags/groups/customcat:theirs"),
      params("customcat:theirs"),
    );
    expect(foreign.status).toBe(404);
    expect(db.moodTag.updateMany).not.toHaveBeenCalled();
  });
});
