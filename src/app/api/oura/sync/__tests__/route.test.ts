/**
 * v1.32.28 — manual Oura sync. Until now Oura only ran on its hourly tick.
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

vi.mock("@/lib/oura/sync", () => ({ syncUserOura: vi.fn() }));

import { POST } from "../route";
import { HttpError, requireAuth } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { syncUserOura } from "@/lib/oura/sync";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/oura/sync", { method: "POST" });
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
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: "u1" },
  } as never);
});

describe("POST /api/oura/sync", () => {
  it("syncs the session user and answers with the imported count", async () => {
    vi.mocked(syncUserOura).mockResolvedValue(12);

    const response = await post(request());

    expect(response.status).toBe(200);
    expect(await envelope(response)).toEqual({
      data: { imported: 12 },
      error: null,
    });
    // The id comes from the session, never from the request.
    expect(syncUserOura).toHaveBeenCalledWith("u1");
  });

  it("refuses an unauthenticated caller before syncing anything", async () => {
    vi.mocked(requireAuth).mockRejectedValue(
      new HttpError(401, "Not authenticated"),
    );

    const response = await post(request());

    expect(response.status).toBe(401);
    expect(syncUserOura).not.toHaveBeenCalled();
  });

  it("refuses past the per-user rate limit without touching the sync", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

    const response = await post(request());
    const body = await envelope(response);

    expect(response.status).toBe(429);
    expect(body.meta?.errorCode).toBe("rate_limited_self");
    expect(syncUserOura).not.toHaveBeenCalled();
    expect(checkRateLimit).toHaveBeenCalledWith("oura-sync:u1", 5, 60_000);
  });

  it("answers 502 generically when the sync throws", async () => {
    vi.mocked(syncUserOura).mockRejectedValue(
      new Error("oura said: token abc123 is invalid"),
    );

    const response = await post(request());
    const body = await envelope(response);

    expect(response.status).toBe(502);
    expect(body.error).toBe("Oura sync failed");
    expect(JSON.stringify(body)).not.toContain("abc123");
  });
});
