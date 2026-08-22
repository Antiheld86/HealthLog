import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/whoop/sync", () => ({ syncUserWhoop: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));

import { POST } from "../route";
import { syncUserWhoop } from "@/lib/whoop/sync";
import { checkRateLimit } from "@/lib/rate-limit";

const sync = syncUserWhoop as ReturnType<typeof vi.fn>;
const limit = checkRateLimit as ReturnType<typeof vi.fn>;

function req(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/whoop/sync", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function raw(body: string): NextRequest {
  return new NextRequest("http://localhost/api/whoop/sync", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  });
}

const post = POST as unknown as (r: NextRequest) => Promise<Response>;

describe("POST /api/whoop/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limit.mockResolvedValue({ allowed: true });
  });

  it("triggers an incremental sync by default", async () => {
    sync.mockResolvedValue({ imported: 7, failed: false });
    const res = await post(req({}));
    const json = (await res.json()) as {
      data: { imported: number; fullSync: boolean };
    };
    expect(json.data.imported).toBe(7);
    expect(json.data.fullSync).toBe(false);
    expect(sync).toHaveBeenCalledWith("u1", { fullSync: false });
  });

  it("treats an absent body as an incremental run", async () => {
    sync.mockResolvedValue({ imported: 1, failed: false });
    const res = await post(req());
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledWith("u1", { fullSync: false });
  });

  it("honours fullSync: true", async () => {
    sync.mockResolvedValue({ imported: 99, failed: false });
    const res = await post(req({ fullSync: true }));
    const json = (await res.json()) as { data: { fullSync: boolean } };
    expect(json.data.fullSync).toBe(true);
    expect(sync).toHaveBeenCalledWith("u1", { fullSync: true });
  });

  /**
   * WHOOP and Withings were the two manual syncs with no limiter at all, while
   * `fullSync` drives the full four-resource history walk against WHOOP's
   * per-user budget. The Fitbit route's own comment records that it was "the
   * outlier" until it got one; these two were never brought along.
   */
  it("refuses once the baseline 5/60s bucket is spent", async () => {
    limit.mockResolvedValueOnce({ allowed: false });
    const res = await post(req({}));
    expect(res.status).toBe(429);
    expect(sync).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith("whoop-sync:u1", 5, 60_000);
  });

  it("caps the full-history walk at one per hour on its own bucket", async () => {
    limit
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });
    const res = await post(req({ fullSync: true }));
    expect(res.status).toBe(429);
    expect(sync).not.toHaveBeenCalled();
    expect(limit).toHaveBeenNthCalledWith(
      2,
      "whoop-sync-full:u1",
      1,
      3_600_000,
    );
  });

  it("does not consult the full-sync bucket for an incremental run", async () => {
    sync.mockResolvedValue({ imported: 0, failed: false });
    await post(req({ fullSync: false }));
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("refuses a present-but-unparseable body instead of syncing", async () => {
    const res = await post(raw("{ fullSync"));
    expect(res.status).toBe(400);
    expect(sync).not.toHaveBeenCalled();
  });

  it("refuses a mistyped fullSync instead of silently going incremental", async () => {
    const res = await post(req({ fullSync: "true" }));
    expect(res.status).toBe(422);
    expect(sync).not.toHaveBeenCalled();
  });
});
