import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ApiHandlerModule from "@/lib/api-handler";

const { readGoogleHealthSyncProgress } = vi.hoisted(() => ({
  readGoogleHealthSyncProgress: vi.fn(),
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof ApiHandlerModule>("@/lib/api-handler");
  return {
    ...actual,
    requireAuth: vi.fn(async () => ({ user: { id: "subject-user" } })),
  };
});

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/google-health/sync-progress", () => ({
  readGoogleHealthSyncProgress,
}));

import { HttpError, requireAuth } from "@/lib/api-handler";

async function getStatus(request: NextRequest) {
  const route = await import("../route");
  return route.GET(request);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: "subject-user" },
  } as never);
});

describe("GET /api/google-health/sync/status", () => {
  it("reads only the authenticated subject despite forged enumeration parameters", async () => {
    readGoogleHealthSyncProgress.mockResolvedValue({
      runId: "run-current",
      state: "in_progress",
      startedAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T10:00:05.000Z",
      resources: [],
    });

    const response = await getStatus(
      new NextRequest(
        "http://localhost/api/google-health/sync/status?userId=other-user&all=true",
      ),
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(readGoogleHealthSyncProgress).toHaveBeenCalledTimes(1);
    expect(readGoogleHealthSyncProgress).toHaveBeenCalledWith("subject-user");
    expect(serialized).not.toContain("other-user");
  });

  it("rejects an unauthenticated read without touching progress storage", async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(
      new HttpError(401, "Not authenticated"),
    );

    const response = await getStatus(
      new NextRequest("http://localhost/api/google-health/sync/status"),
    );

    expect(response.status).toBe(401);
    expect(readGoogleHealthSyncProgress).not.toHaveBeenCalled();
  });

  it("returns one bounded current-run envelope, never an owner list or private payload", async () => {
    readGoogleHealthSyncProgress.mockResolvedValue({
      runId: "run-private",
      state: "partial",
      startedAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T10:05:00.000Z",
      terminalAt: "2026-07-29T10:05:00.000Z",
      resources: [
        {
          resource: "workout",
          pages: 1,
          fetched: 1,
          mapped: 1,
          written: 1,
          status: "complete",
          durationMs: 25,
          truncated: false,
          reasonCode: null,
          accessToken: "raw-access-token",
          rawError: "provider response body",
          url: "https://provider.invalid/private",
          samples: [{ bpm: 181 }],
        },
      ],
      owners: ["subject-user", "other-user"],
    });

    const response = await getStatus(
      new NextRequest("http://localhost/api/google-health/sync/status"),
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.data).not.toBeInstanceOf(Array);
    expect(serialized).not.toMatch(
      /raw-access-token|provider response body|provider\.invalid|samples|bpm|181|owners|other-user/,
    );
  });
});
