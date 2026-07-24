import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.32.21 (R5a) — optimistic concurrency on `PUT /api/coach/about-me`
 * (issue #581 family). The write guards on `UserHealthProfile.updatedAt`:
 *
 *   - a stale base token → 409 `about_me_conflict`, no write;
 *   - a matched base token → conditional update, fresh token echoed;
 *   - a zero-match against a MISSING row → create wins (nothing to clobber);
 *   - a tokenless request → the prior unconditional upsert (iOS-compat arm).
 *
 * Mirrors the mock scaffolding of `route-module-gate.test.ts`.
 */

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
}));

const { requireModuleEnabled } = vi.hoisted(() => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));
vi.mock("@/lib/modules/gate", () => ({ requireModuleEnabled }));

vi.mock("@/lib/api-response", () => ({
  apiError: (error: string, status: number, meta?: unknown) => ({
    data: null,
    error,
    status,
    meta,
  }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  getClientIp: () => "127.0.0.1",
  returnAllZodIssues: (_e: unknown, status: number) => ({
    data: null,
    error: "validation",
    status,
  }),
  safeJson: async (req: Request) => ({ data: await req.json(), error: null }),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));

const { profile } = vi.hoisted(() => ({
  profile: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ prisma: { userHealthProfile: profile } }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (s: string) => Buffer.from(s),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextForUser: vi.fn(async () => ({
    aboutMe: null,
    conditions: null,
    allergies: null,
    coachFocus: null,
  })),
  getPendingQuestionsForUser: vi.fn(async () => []),
  setPendingQuestionsForUser: vi.fn(),
}));
vi.mock("@/lib/ai/coach/self-context-questions", () => ({
  deriveClarifyingQuestions: vi.fn(async () => ({
    questions: [],
    source: "none",
  })),
}));

import { PUT } from "../route";

type Envelope = {
  data: { updatedAt?: string } | null;
  error: string | null;
  status: number;
  meta?: { errorCode?: string };
};
const put = PUT as unknown as (req: Request) => Promise<Envelope>;

function putReq(baseUpdatedAt?: string): Request {
  return new Request("http://localhost/api/coach/about-me", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      aboutMe: "I run daily",
      ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireModuleEnabled.mockResolvedValue({ enabled: true });
});

describe("about-me — optimistic concurrency", () => {
  it("guards on the base token and echoes the advanced token", async () => {
    const base = new Date("2026-07-24T10:00:00.000Z");
    const advanced = new Date("2026-07-24T10:05:00.000Z");
    profile.updateMany.mockResolvedValue({ count: 1 });
    profile.findUnique.mockResolvedValue({ updatedAt: advanced });

    const res = await put(putReq(base.toISOString()));
    expect(res.status).toBe(200);

    // Conditional write on the exact base token — never the upsert.
    expect(profile.updateMany).toHaveBeenCalledTimes(1);
    const whereArg = profile.updateMany.mock.calls[0]?.[0]?.where as {
      userId: string;
      updatedAt: Date;
    };
    expect(whereArg.userId).toBe("u1");
    expect((whereArg.updatedAt as Date).toISOString()).toBe(base.toISOString());
    expect(profile.upsert).not.toHaveBeenCalled();
    expect(res.data?.updatedAt).toBe(advanced.toISOString());
  });

  it("a stale base token 409s and clobbers nothing (existing row advanced)", async () => {
    profile.updateMany.mockResolvedValue({ count: 0 });
    // The row exists but its token advanced → real conflict, not a delete.
    profile.findUnique.mockResolvedValue({
      updatedAt: new Date("2026-07-24T10:05:00.000Z"),
    });

    const res = await put(putReq("2026-07-24T09:00:00.000Z"));
    expect(res.status).toBe(409);
    expect(res.data).toBeNull();
    expect(res.meta?.errorCode).toBe("about_me_conflict");

    // No write happened: neither the upsert nor a create ran.
    expect(profile.upsert).not.toHaveBeenCalled();
    expect(profile.create).not.toHaveBeenCalled();
  });

  it("a zero-match against a MISSING row creates instead of 409ing", async () => {
    profile.updateMany.mockResolvedValue({ count: 0 });
    profile.findUnique.mockResolvedValue(null);
    profile.create.mockResolvedValue({
      updatedAt: new Date("2026-07-24T12:00:00.000Z"),
    });

    const res = await put(putReq("2026-07-24T09:00:00.000Z"));
    expect(res.status).toBe(200);
    expect(profile.create).toHaveBeenCalledTimes(1);
    expect(res.data?.updatedAt).toBe("2026-07-24T12:00:00.000Z");
  });

  it("keeps the unconditional upsert when the token is omitted (iOS compat)", async () => {
    profile.upsert.mockResolvedValue({
      updatedAt: new Date("2026-07-24T11:00:00.000Z"),
    });

    const res = await put(putReq());
    expect(res.status).toBe(200);
    expect(profile.upsert).toHaveBeenCalledTimes(1);
    expect(profile.updateMany).not.toHaveBeenCalled();
    expect(res.data?.updatedAt).toBe("2026-07-24T11:00:00.000Z");
  });

  it("422s a malformed base token without touching the row", async () => {
    const res = await put(putReq("not-a-date"));
    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(profile.updateMany).not.toHaveBeenCalled();
    expect(profile.upsert).not.toHaveBeenCalled();
  });
});
