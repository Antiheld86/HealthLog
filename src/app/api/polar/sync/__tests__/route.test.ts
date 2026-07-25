/**
 * v1.32.28 — manual Polar sync.
 *
 * The entry point matters as much as the behaviour: the route must call
 * `syncUserPolarLegs`, the same seam the hourly poll uses, so both legs run
 * with the attribution rules built for them. Calling the vitals leg alone would
 * quietly import half of Polar and stamp the ledger wrong, and a naive test
 * that only asserted a row count would not notice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type * as ApiHandlerModule from "@/lib/api-handler";

const { syncUserPolarMock, syncUserPolarWorkoutsMock } = vi.hoisted(() => ({
  syncUserPolarMock: vi.fn(),
  syncUserPolarWorkoutsMock: vi.fn(),
}));

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

// Mock the two LEGS rather than the wrapper, so the real `syncUserPolarLegs`
// runs and the test can see whether both of them were driven.
vi.mock("@/lib/polar/sync", () => ({
  syncUserPolar: syncUserPolarMock,
  recordPolarSyncFailure: vi.fn(),
}));
vi.mock("@/lib/polar/sync-workouts", () => ({
  syncUserPolarWorkouts: syncUserPolarWorkoutsMock,
}));

import { POST } from "../route";
import { HttpError, requireAuth } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/polar/sync", { method: "POST" });
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
  syncUserPolarMock.mockResolvedValue(0);
  syncUserPolarWorkoutsMock.mockResolvedValue(0);
});

describe("POST /api/polar/sync", () => {
  it("runs both Polar legs and totals what they imported", async () => {
    syncUserPolarMock.mockResolvedValue(5);
    syncUserPolarWorkoutsMock.mockResolvedValue(2);

    const response = await post(request());

    expect(response.status).toBe(200);
    expect(await envelope(response)).toEqual({
      data: { imported: 7 },
      error: null,
    });
    expect(syncUserPolarMock).toHaveBeenCalledWith("u1");
    expect(syncUserPolarWorkoutsMock).toHaveBeenCalledWith("u1");
  });

  it("goes through the shared legs entry point, not the provider internals", () => {
    const source = readFileSync(join(__dirname, "..", "route.ts"), "utf8");
    expect(source).toContain("syncUserPolarLegs");
    expect(source).not.toMatch(/from "@\/lib\/polar\//);
  });

  it("refuses an unauthenticated caller before syncing anything", async () => {
    vi.mocked(requireAuth).mockRejectedValue(
      new HttpError(401, "Not authenticated"),
    );

    const response = await post(request());

    expect(response.status).toBe(401);
    expect(syncUserPolarMock).not.toHaveBeenCalled();
    expect(syncUserPolarWorkoutsMock).not.toHaveBeenCalled();
  });

  it("refuses past the per-user rate limit without touching the sync", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

    const response = await post(request());
    const body = await envelope(response);

    expect(response.status).toBe(429);
    expect(body.meta?.errorCode).toBe("rate_limited_self");
    expect(syncUserPolarMock).not.toHaveBeenCalled();
    expect(checkRateLimit).toHaveBeenCalledWith("polar-sync:u1", 5, 60_000);
  });

  it("answers 502 generically when a leg throws", async () => {
    syncUserPolarMock.mockRejectedValue(
      new Error("polar said: token abc123 is invalid"),
    );

    const response = await post(request());
    const body = await envelope(response);

    expect(response.status).toBe(502);
    expect(body.error).toBe("Polar sync failed");
    expect(JSON.stringify(body)).not.toContain("abc123");
  });
});
