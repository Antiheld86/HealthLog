/**
 * v1.35.0 — GET/PATCH /api/auth/me/health-score-config.
 *
 * Covers the read projection, the positive-selection-in /
 * deselection-out inversion, the write-time breadth refusal, the
 * monotonic recipe version, and the score-cache eviction. The
 * invalidation assertion is here because a missing one is invisible:
 * the write succeeds, the response is right, and the person keeps
 * seeing the old number for an hour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
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

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/cache/invalidate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/cache/invalidate")>();
  return { ...actual, invalidateUserHealthScore: vi.fn() };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import type { ScorePillarId } from "@/lib/analytics/score/types";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const ALL_EIGHT: ScorePillarId[] = [
  "BLOOD_PRESSURE",
  "GLYCAEMIA",
  "ACTIVITY",
  "SLEEP",
  "ADIPOSITY",
  "WELLBEING",
  "FITNESS",
  "LIPIDS",
];

interface ResolvedBody {
  pillars: ScorePillarId[];
  excludedPillars: ScorePillarId[];
  hasSelection: boolean;
  version: number;
  changedAt: string | null;
  updatedAt?: string;
}

function mkPatch(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/health-score-config", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/** Mutable row, so a write is visible to the read that follows it. */
function primeUser(healthScoreConfigJson: unknown = null) {
  const row: { healthScoreConfigJson: unknown; updatedAt: Date } = {
    healthScoreConfigJson,
    updatedAt: new Date("2026-07-31T09:00:00.000Z"),
  };
  vi.mocked(prisma.user.findUnique).mockImplementation((() =>
    Promise.resolve({ ...row })) as never);
  vi.mocked(prisma.user.update).mockImplementation(((args: {
    data?: { healthScoreConfigJson?: unknown };
  }) => {
    if (args.data && "healthScoreConfigJson" in args.data) {
      row.healthScoreConfigJson = args.data.healthScoreConfigJson;
    }
    return Promise.resolve({ updatedAt: row.updatedAt });
  }) as never);
  return row;
}

function writtenConfig(): {
  excludedPillars: ScorePillarId[];
  version: number;
  changedAt: string;
} {
  const call = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as unknown as {
    data: {
      healthScoreConfigJson: {
        excludedPillars: ScorePillarId[];
        version: number;
        changedAt: string;
      };
    };
  };
  return call.data.healthScoreConfigJson;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me/health-score-config", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/health-score-config"),
    );
    expect(res.status).toBe(401);
  });

  it("reports every pillar counting, and no selection, for a fresh account", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/health-score-config"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: ResolvedBody };
    expect(env.data.pillars).toEqual(ALL_EIGHT);
    expect(env.data.hasSelection).toBe(false);
    expect(env.data.version).toBe(0);
    expect(env.data.updatedAt).toBeUndefined();
  });

  it("reports a stored selection as the pillars it leaves counting", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({
      excludedPillars: ["SLEEP", "LIPIDS"],
      version: 2,
      changedAt: "2026-07-30T08:00:00.000Z",
    });
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/health-score-config"),
    );
    const env = (await res.json()) as { data: ResolvedBody };
    expect(env.data.pillars).toEqual(
      ALL_EIGHT.filter((id) => id !== "SLEEP" && id !== "LIPIDS"),
    );
    expect(env.data.excludedPillars).toEqual(["SLEEP", "LIPIDS"]);
    expect(env.data.hasSelection).toBe(true);
    expect(env.data.version).toBe(2);
    expect(env.data.updatedAt).toBe("2026-07-31T09:00:00.000Z");
  });
});

describe("PATCH /api/auth/me/health-score-config", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_EIGHT }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("stores the complement of the selection and returns the selection", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    const selection: ScorePillarId[] = [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
    ];

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: selection }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: ResolvedBody };
    expect(env.data.pillars).toEqual(selection);
    expect(env.data.hasSelection).toBe(true);

    const stored = writtenConfig();
    expect(stored.excludedPillars).toEqual(
      ALL_EIGHT.filter((id) => !selection.includes(id)),
    );
    expect(stored.version).toBe(1);
    expect(stored.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(auditLog).toHaveBeenCalledWith(
      "user.health_score_config.update",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("increments the recipe version on every accepted write", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({
      excludedPillars: ["LIPIDS"],
      version: 7,
      changedAt: "2026-07-01T00:00:00.000Z",
    });

    await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_EIGHT }),
    );
    expect(writtenConfig().version).toBe(8);
  });

  it("keeps a kept-everything selection as an authored choice", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_EIGHT }),
    );
    const env = (await res.json()) as { data: ResolvedBody };
    expect(writtenConfig().excludedPillars).toEqual([]);
    expect(env.data.hasSelection).toBe(true);
  });

  it("evicts the score caches so the old number is not served on", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_EIGHT }),
    );
    expect(invalidateUserHealthScore).toHaveBeenCalledWith("user-1");
  });
});

describe("PATCH — the breadth rule", () => {
  it("refuses activity and wellbeing alone, in words a person can act on", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ["ACTIVITY", "WELLBEING"] }),
    );
    expect(res.status).toBe(422);
    const env = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string; reason?: string };
    };
    expect(env.meta?.errorCode).toBe("health_score_config.too_narrow");
    expect(env.meta?.reason).toBe("measured_physiological_domain_required");
    expect(env.error).toContain("at least one physical measurement");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(invalidateUserHealthScore).not.toHaveBeenCalled();
  });

  it("refuses the cardiometabolic triple, which is three pillars in one area", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ["BLOOD_PRESSURE", "GLYCAEMIA", "LIPIDS"] }),
    );
    expect(res.status).toBe(422);
    const env = (await res.json()) as {
      error: string;
      meta?: { reason?: string };
    };
    expect(env.meta?.reason).toBe("three_domains_required");
    expect(env.error).toContain("three different areas");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses an empty selection rather than storing a score that cannot exist", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: [] }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("accepts the smallest selection that clears the rule", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"] }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH — envelope and transport", () => {
  it("rejects an unknown pillar id with 422 and writes nothing", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ["BLOOD_PRESSURE", "MOON_PHASE", "SLEEP"] }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown body key with 422 (strict stays strict)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_EIGHT, weights: { SLEEP: 2 } }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses a userId in the body", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_EIGHT, userId: "user-2" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const req = new Request(
      "http://localhost/api/auth/me/health-score-config",
      {
        method: "PATCH",
        body: "{ not valid json",
        headers: { "Content-Type": "application/json" },
      },
    );
    const res = await (PATCH as (r: Request) => Promise<Response>)(req);
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-user rate limit fires", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    });
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_EIGHT }),
    );
    expect(res.status).toBe(429);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("guards the write on the base token and 409s a stale one", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({
        pillars: ALL_EIGHT,
        baseUpdatedAt: "2026-07-24T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(409);
    const env = (await res.json()) as { meta?: { errorCode?: string } };
    expect(env.meta?.errorCode).toBe("health_score_config_conflict");
    expect(prisma.user.update).not.toHaveBeenCalled();
    // A write that never landed must not evict the caches either.
    expect(invalidateUserHealthScore).not.toHaveBeenCalled();
  });
});
