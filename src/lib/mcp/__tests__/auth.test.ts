import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/bearer", () => ({
  resolveBearerToken: vi.fn(),
}));

import { resolveMcpAuthContext } from "../auth";
import { resolveBearerToken } from "@/lib/auth/bearer";

const FAKE_USER = { id: "user-1", role: "USER" } as never;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveMcpAuthContext", () => {
  it("binds a health:read session to <userId>:<tokenId> via the canonical Bearer path", async () => {
    vi.mocked(resolveBearerToken).mockResolvedValue({
      user: FAKE_USER,
      tokenId: "token-9",
      permissions: ["health:read"],
      expiresAt: new Date(),
    });

    const ctx = await resolveMcpAuthContext("  hlk_abc  ");

    expect(resolveBearerToken).toHaveBeenCalledWith("hlk_abc", {
      kind: "any-valid-token",
    });
    expect(ctx.userId).toBe("user-1");
    expect(ctx.tokenId).toBe("token-9");
    expect(ctx.binding).toBe("user-1:token-9");
    expect(ctx.canRead).toBe(true);
    expect(ctx.canWrite).toBe(false);
  });

  it("admits wildcard read capability and preserves wildcard write capability", async () => {
    vi.mocked(resolveBearerToken).mockResolvedValue({
      user: FAKE_USER,
      tokenId: "token-wild",
      permissions: ["*"],
      expiresAt: new Date(),
    });
    const ctx = await resolveMcpAuthContext("hlk_wild");
    expect(ctx.canRead).toBe(true);
    expect(ctx.canWrite).toBe(true);
  });

  it("does not infer read capability from health:write", async () => {
    vi.mocked(resolveBearerToken).mockResolvedValue({
      user: FAKE_USER,
      tokenId: "token-w",
      permissions: ["health:write"],
      expiresAt: new Date(),
    });
    const ctx = await resolveMcpAuthContext("hlk_xyz");
    expect(ctx.canRead).toBe(false);
    expect(ctx.canWrite).toBe(true);
  });

  it.each([
    ["medication ingest", ["medication:ingest"]],
    ["notification delivery", ["notifications:send"]],
    ["FHIR read", ["fhir:read"]],
    ["unrelated", ["profile:read"]],
    ["empty", []],
  ])("does not grant MCP reads to a valid %s token", async (_label, scopes) => {
    vi.mocked(resolveBearerToken).mockResolvedValue({
      user: FAKE_USER,
      tokenId: "token-narrow",
      permissions: scopes,
      expiresAt: new Date(),
    });

    const ctx = await resolveMcpAuthContext("hlk_narrow");

    expect(ctx.canRead).toBe(false);
  });

  it("rejects an empty token without calling the validator", async () => {
    await expect(resolveMcpAuthContext("   ")).rejects.toThrow();
    expect(resolveBearerToken).not.toHaveBeenCalled();
  });

  it("propagates a rejection from the Bearer validator (invalid / revoked / expired)", async () => {
    vi.mocked(resolveBearerToken).mockRejectedValue(new Error("revoked"));
    await expect(resolveMcpAuthContext("hlk_bad")).rejects.toThrow();
  });
});
