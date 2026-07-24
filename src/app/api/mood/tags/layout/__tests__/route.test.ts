/**
 * v1.32.22 (M2) — `PUT /api/mood/tags/layout` optimistic concurrency.
 *
 * The two manage cards write DIFFERENT fields of the same blob (group order
 * vs placements) from the same page; a stale merge would resurrect the other
 * card's overwritten field. The base token 409s that instead. A tokenless PUT
 * keeps the prior unconditional write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    moodTagCategory: {
      findMany: vi.fn(),
    },
  },
  toJson: <T>(v: T) => v,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: vi.fn() };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PUT } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function mkPut(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mood/tags/layout", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.moodTagCategory.findMany).mockResolvedValue([] as never);
});

describe("GET /api/mood/tags/layout", () => {
  it("returns the layout plus the optimistic-concurrency token", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      moodTagLayoutJson: { groupOrder: ["a", "b"], placements: {} },
      updatedAt: new Date("2026-07-24T10:00:00.000Z"),
    } as never);

    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { groupOrder: string[]; updatedAt?: string };
    };
    expect(env.data.updatedAt).toBe("2026-07-24T10:00:00.000Z");
  });

  it("omits updatedAt for a fresh user (null row)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      moodTagLayoutJson: null,
    } as never);

    const res = await (GET as () => Promise<Response>)();
    const env = (await res.json()) as {
      data: { updatedAt?: string };
    };
    expect(env.data.updatedAt).toBeUndefined();
  });
});

describe("PUT /api/mood/tags/layout — optimistic concurrency", () => {
  it("guards on the base token and echoes the advanced token", async () => {
    vi.mocked(prisma.user.findUnique)
      // merge read
      .mockResolvedValueOnce({ moodTagLayoutJson: null } as never)
      // post-write fresh token
      .mockResolvedValueOnce({
        updatedAt: new Date("2026-07-24T10:05:00.000Z"),
      } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);

    const res = await (PUT as (r: NextRequest) => Promise<Response>)(
      mkPut({
        groupOrder: ["a", "b"],
        baseUpdatedAt: "2026-07-24T10:00:00.000Z",
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const whereArg = vi.mocked(prisma.user.updateMany).mock.calls[0]?.[0]
      ?.where as { id: string; updatedAt: Date };
    expect((whereArg.updatedAt as Date).toISOString()).toBe(
      "2026-07-24T10:00:00.000Z",
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    const env = (await res.json()) as { data: { updatedAt: string } };
    expect(env.data.updatedAt).toBe("2026-07-24T10:05:00.000Z");
  });

  it("interleaved writers: the stale-base second writer gets 409 and clobbers nothing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      moodTagLayoutJson: { groupOrder: ["a"], placements: {} },
    } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await (PUT as (r: NextRequest) => Promise<Response>)(
      mkPut({
        placements: { a: ["t1"] },
        baseUpdatedAt: "2026-07-24T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(409);
    const env = (await res.json()) as { meta?: { errorCode?: string } };
    expect(env.meta?.errorCode).toBe("mood_tag_layout_conflict");
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps the unconditional write when the token is omitted (compat)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      moodTagLayoutJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      updatedAt: new Date("2026-07-24T11:00:00.000Z"),
    } as never);

    const res = await (PUT as (r: NextRequest) => Promise<Response>)(
      mkPut({ groupOrder: ["a", "b"] }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("422s a malformed base token without touching the row", async () => {
    const res = await (PUT as (r: NextRequest) => Promise<Response>)(
      mkPut({ groupOrder: ["a"], baseUpdatedAt: "not-a-date" }),
    );
    expect(res.status).toBe(422);
    const env = (await res.json()) as { meta?: { errorCode?: string } };
    expect(env.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
