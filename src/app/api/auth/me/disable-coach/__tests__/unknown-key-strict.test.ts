/**
 * The strict half, end to end on a real route.
 *
 * `patchBodySchema` is `.strict()`, so a PATCH carrying a key the route
 * does not declare is refused rather than trimmed down to the keys it
 * does. Before that, `{ disableCoachh: true }` parsed clean as `{}` —
 * except `disableCoach` is required, so this particular body already
 * 422'd on the missing field. The one worth pinning is the body that
 * used to succeed while doing something other than what it said:
 * `{ disableCoach: true, disableCoachh: false }`.
 *
 * The second assertion is the user-visible half. A 422 that says only
 * "Validation failed" leaves the caller staring at a body it believes is
 * correct, so the envelope has to name the key it refused — and name it
 * without reflecting a hostile one back verbatim.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
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
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function mkPatch(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/disable-coach", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const patch = PATCH as (r: Request) => Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.user.update).mockResolvedValue({
    disableCoach: true,
  } as never);
});

describe("PATCH /api/auth/me/disable-coach — unknown keys", () => {
  it("accepts the declared body", async () => {
    const res = await patch(mkPatch({ disableCoach: true }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("refuses a body that carries an undeclared key alongside a valid one", async () => {
    const res = await patch(
      mkPatch({ disableCoach: true, disableCoachh: false }),
    );
    expect(res.status).toBe(422);
    // Nothing was written. Before `.strict()` this wrote `disableCoach:
    // true` and answered 200, so a caller that meant the second field
    // was told its request had been honoured.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("names the offending key in the 422", async () => {
    const res = await patch(
      mkPatch({ disableCoach: true, disableCoachh: false }),
    );
    const body = (await res.json()) as {
      error: string;
      details?: {
        issues: Array<{ code: string; message: string; keys?: string[] }>;
      };
    };
    const issue = body.details?.issues.find(
      (i) => i.code === "unrecognized_keys",
    );
    expect(issue).toBeDefined();
    expect(issue?.keys).toEqual(["disableCoachh"]);
    expect(issue?.message).toContain("disableCoachh");
  });

  it("does not reflect a hostile key name back verbatim", async () => {
    const res = await patch(
      mkPatch({ disableCoach: true, "<script>alert(1)</script>": 1 }),
    );
    expect(res.status).toBe(422);
    const raw = await res.text();
    expect(raw).not.toContain("<script>");
    expect(raw).toContain("script_alert_1");
  });
});
