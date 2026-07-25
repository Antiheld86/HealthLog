/**
 * v1.32.28 — manual Strava sync. Incremental by nature (Strava carries a real
 * cursor); no full-history arm is exposed here, that stays with the backfill.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ApiHandlerModule from "@/lib/api-handler";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof ApiHandlerModule>("@/lib/api-handler");
  return {
    ...actual,
    requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
  };
});

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/strava/sync", () => ({ syncUserStrava: vi.fn() }));

import { POST } from "../route";
import { HttpError, requireAuth } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { syncUserStrava } from "@/lib/strava/sync";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/strava/sync", {
    method: "POST",
  });
}

// The route takes no arguments (no body, no flags); the alias keeps the
// direct invoke typed while still handing apiHandler a real request.
const post = POST as unknown as (r: NextRequest) => Promise<Response>;

async function envelope(response: Response) {
  return (await response.json()) as {
    data: { imported?: number } | null;
    error: string | null;
    meta?: { errorCode?: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: "u1" } } as never);
});

describe("POST /api/strava/sync", () => {
  it("syncs the session user and answers with the imported count", async () => {
    vi.mocked(syncUserStrava).mockResolvedValue(4);

    const response = await post(request());

    expect(response.status).toBe(200);
    expect(await envelope(response)).toEqual({
      data: { imported: 4 },
      error: null,
    });
    expect(syncUserStrava).toHaveBeenCalledWith("u1");
  });

  it("refuses an unauthenticated caller before syncing anything", async () => {
    vi.mocked(requireAuth).mockRejectedValue(
      new HttpError(401, "Not authenticated"),
    );

    const response = await post(request());

    expect(response.status).toBe(401);
    expect(syncUserStrava).not.toHaveBeenCalled();
  });

  it("refuses past the per-user rate limit without touching the sync", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

    const response = await post(request());
    const body = await envelope(response);

    expect(response.status).toBe(429);
    expect(body.meta?.errorCode).toBe("rate_limited_self");
    expect(syncUserStrava).not.toHaveBeenCalled();
    expect(checkRateLimit).toHaveBeenCalledWith("strava-sync:u1", 5, 60_000);
  });

  it("answers 502 generically when the sync throws", async () => {
    vi.mocked(syncUserStrava).mockRejectedValue(
      new Error("strava said: token abc123 is invalid"),
    );

    const response = await post(request());
    const body = await envelope(response);

    expect(response.status).toBe(502);
    expect(body.error).toBe("Strava sync failed");
    expect(JSON.stringify(body)).not.toContain("abc123");
  });
});
