import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/whoop/sync", () => ({ syncUserWhoop: vi.fn() }));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null }),
}));

import { POST } from "../route";
import { syncUserWhoop } from "@/lib/whoop/sync";

const sync = syncUserWhoop as ReturnType<typeof vi.fn>;

function req(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/whoop/sync", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/whoop/sync", () => {
  beforeEach(() => vi.clearAllMocks());

  it("triggers an incremental sync by default", async () => {
    sync.mockResolvedValue({ imported: 7, failed: false });
    const res = (await (
      POST as unknown as (r: NextRequest) => Promise<{ data: unknown }>
    )(req({}))) as { data: { imported: number; fullSync: boolean } };
    expect(res.data.imported).toBe(7);
    expect(res.data.fullSync).toBe(false);
    expect(sync).toHaveBeenCalledWith("u1", { fullSync: false });
  });

  it("honours fullSync: true", async () => {
    sync.mockResolvedValue({ imported: 99, failed: false });
    const res = (await (
      POST as unknown as (r: NextRequest) => Promise<{ data: unknown }>
    )(req({ fullSync: true }))) as { data: { fullSync: boolean } };
    expect(res.data.fullSync).toBe(true);
    expect(sync).toHaveBeenCalledWith("u1", { fullSync: true });
  });
});
