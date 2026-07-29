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

vi.mock("@/lib/google-health/sync", () => ({
  syncUserGoogleHealth: vi.fn(),
}));

import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";
import { syncUserGoogleHealth } from "@/lib/google-health/sync";

function request(body: unknown = {}): NextRequest {
  return new NextRequest("http://localhost/api/google-health/sync", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/google-health/sync", () => {
  it("returns a non-success envelope when the core sync reports failure", async () => {
    vi.mocked(syncUserGoogleHealth).mockResolvedValue({
      imported: 0,
      failed: true,
    });

    const response = await POST(request());
    const envelope = (await response.json()) as {
      data: unknown;
      error: string | null;
    };

    expect(response.status).toBe(502);
    expect(envelope.data).toBeNull();
    expect(envelope.error).toBe("Google Health sync failed");
  });

  it("reports a run that failed after writing some resources as a partial", async () => {
    // A 502 threw the honest half away: rows DID land, and the card showed the
    // generic error instead of "imported N, some data is behind".
    vi.mocked(syncUserGoogleHealth).mockResolvedValue({
      imported: 7,
      failed: true,
    });

    const response = await POST(request());
    const envelope = (await response.json()) as {
      data: { imported: number; failed: boolean; outcome: string };
      error: string | null;
    };

    expect(response.status).toBe(200);
    expect(envelope.data).toMatchObject({
      imported: 7,
      failed: true,
      outcome: "partial",
    });
  });

  it("keeps the successful imported-count response unchanged", async () => {
    vi.mocked(syncUserGoogleHealth).mockResolvedValue({
      imported: 7,
      failed: false,
    });

    const response = await POST(request());
    const envelope = (await response.json()) as {
      data: { imported: number; fullSync: boolean };
      error: string | null;
    };

    expect(response.status).toBe(200);
    expect(envelope).toEqual({
      data: { imported: 7, failed: false, outcome: "success", fullSync: false },
      error: null,
    });
    expect(syncUserGoogleHealth).toHaveBeenCalledWith("u1", {
      fullSync: false,
    });
  });

  it("preserves bounded per-resource terminal outcomes for the manual-sync client", async () => {
    vi.mocked(syncUserGoogleHealth).mockResolvedValue({
      runId: "run-terminal-1",
      state: "partial",
      imported: 3,
      failed: true,
      resources: [
        {
          resource: "workout",
          pages: 1,
          fetched: 2,
          mapped: 2,
          written: 2,
          status: "complete",
          durationMs: 18,
          truncated: false,
          reasonCode: null,
        },
        {
          resource: "dense-heart-rate",
          pages: 786,
          fetched: 1,
          mapped: 1,
          written: 1,
          status: "partial",
          durationMs: 323_849,
          truncated: false,
          reasonCode: "collection_failed",
        },
      ],
    } as never);

    const response = await POST(request());
    const envelope = (await response.json()) as {
      data: Record<string, unknown>;
      error: string | null;
    };

    expect(response.status).toBe(200);
    expect(envelope.error).toBeNull();
    expect(envelope.data).toEqual({
      runId: "run-terminal-1",
      state: "partial",
      imported: 3,
      failed: true,
      outcome: "partial",
      fullSync: false,
      resources: [
        {
          resource: "workout",
          pages: 1,
          fetched: 2,
          mapped: 2,
          written: 2,
          status: "complete",
          durationMs: 18,
          truncated: false,
          reasonCode: null,
        },
        {
          resource: "dense-heart-rate",
          pages: 786,
          fetched: 1,
          mapped: 1,
          written: 1,
          status: "partial",
          durationMs: 323_849,
          truncated: false,
          reasonCode: "collection_failed",
        },
      ],
    });
  });

  it("does not serialize provider payloads, URLs, tokens, or health values", async () => {
    vi.mocked(syncUserGoogleHealth).mockResolvedValue({
      runId: "run-private",
      state: "failed",
      imported: 1,
      failed: true,
      resources: [
        {
          resource: "workout",
          pages: 1,
          fetched: 2,
          mapped: 2,
          written: 1,
          status: "partial",
          durationMs: 20,
          truncated: false,
          reasonCode: "upsert_failed",
          accessToken: "raw-access-token",
          url: "https://health.googleapis.com/private",
          rawError: "provider response body",
          samples: [{ bpm: 181 }],
        },
      ],
    } as never);

    const response = await POST(request());
    const serialized = JSON.stringify(await response.json());

    expect(serialized).not.toMatch(
      /raw-access-token|health\.googleapis\.com|provider response body|samples|bpm|181/,
    );
  });
});
