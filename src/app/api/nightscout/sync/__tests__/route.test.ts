/**
 * v1.32.28 — manual Nightscout sync.
 *
 * The error arm carries the load here: a Nightscout base URL carries the API
 * token as a query parameter, so an upstream message can contain the user's
 * secret. The route answers with a fixed string and never the caught message.
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

vi.mock("@/lib/nightscout/sync", () => ({ syncUserNightscout: vi.fn() }));

import { POST } from "../route";
import { HttpError, requireAuth } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { syncUserNightscout } from "@/lib/nightscout/sync";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/nightscout/sync", {
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

describe("POST /api/nightscout/sync", () => {
  it("syncs the session user and answers with the freshly inserted count", async () => {
    vi.mocked(syncUserNightscout).mockResolvedValue({
      imported: 36,
      failed: false,
    });

    const response = await post(request());

    expect(response.status).toBe(200);
    expect(await envelope(response)).toEqual({
      data: { imported: 36, failed: false, outcome: "success" },
      error: null,
    });
    expect(syncUserNightscout).toHaveBeenCalledWith("u1");
  });

  it("does not call a window whose every row was refused a success", async () => {
    // The defect: 200 + `imported: 0` rendered as a green tick with a count,
    // when in fact not one SGV row reached the database.
    vi.mocked(syncUserNightscout).mockResolvedValue({
      imported: 0,
      failed: true,
    });

    const response = await post(request());

    expect(response.status).toBe(200);
    expect((await envelope(response)).data).toEqual({
      imported: 0,
      failed: true,
      outcome: "failed",
    });
  });

  it("calls a window that wrote some rows and lost others a partial", async () => {
    vi.mocked(syncUserNightscout).mockResolvedValue({
      imported: 30,
      failed: true,
    });

    const response = await post(request());

    expect((await envelope(response)).data).toMatchObject({
      outcome: "partial",
    });
  });

  it("calls a window that found nothing new empty, not a success", async () => {
    vi.mocked(syncUserNightscout).mockResolvedValue({
      imported: 0,
      failed: false,
    });

    const response = await post(request());

    expect((await envelope(response)).data).toMatchObject({
      outcome: "empty",
    });
  });

  it("refuses an unauthenticated caller before syncing anything", async () => {
    vi.mocked(requireAuth).mockRejectedValue(
      new HttpError(401, "Not authenticated"),
    );

    const response = await post(request());

    expect(response.status).toBe(401);
    expect(syncUserNightscout).not.toHaveBeenCalled();
  });

  it("refuses past the per-user rate limit without touching the sync", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

    const response = await post(request());
    const body = await envelope(response);

    expect(response.status).toBe(429);
    expect(body.meta?.errorCode).toBe("rate_limited_self");
    expect(syncUserNightscout).not.toHaveBeenCalled();
    expect(checkRateLimit).toHaveBeenCalledWith(
      "nightscout-sync:u1",
      5,
      60_000,
    );
  });

  it("never echoes the token-bearing instance URL into the response body", async () => {
    vi.mocked(syncUserNightscout).mockRejectedValue(
      new Error(
        "GET https://cgm.example.org/api/v1/entries.json?token=hunter2secret failed with 401",
      ),
    );

    const response = await post(request());
    const body = await envelope(response);
    const serialised = JSON.stringify(body);

    expect(response.status).toBe(502);
    expect(body.error).toBe("Nightscout sync failed");
    expect(serialised).not.toContain("hunter2secret");
    expect(serialised).not.toContain("cgm.example.org");
    expect(serialised).not.toContain("token=");
  });

  it("returns a stable operator-action reason for an unapproved legacy private connection", async () => {
    vi.mocked(syncUserNightscout).mockRejectedValue(
      Object.assign(
        new Error(
          "GET http://10.0.0.4:1337/api/v1/entries.json?token=hunter2secret refused",
        ),
        { reasonCode: "private_origin_not_approved" },
      ),
    );

    const response = await post(request());
    const body = await envelope(response);
    const serialised = JSON.stringify(body);

    expect(response.status).toBe(422);
    expect(body.error).toBe(
      "Private Nightscout access requires server operator approval",
    );
    expect(body.meta?.errorCode).toBe("private_origin_not_approved");
    expect(serialised).not.toContain("10.0.0.4");
    expect(serialised).not.toContain("hunter2secret");
  });
});
