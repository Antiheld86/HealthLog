/**
 * Guard: the MCP connector mint endpoint mints ONLY the two allowed scope
 * shapes — `["health:read"]` (default) or `["health:read","health:write"]` —
 * and never a wildcard or any other grant.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    session: {
      findUnique: vi.fn(async () => ({
        createdAt: new Date(),
        mfaVerifiedAt: null,
        reproofAt: null,
      })),
    },
    webauthnMfaCredential: { count: vi.fn(async () => 0) },
    passkey: { count: vi.fn(async () => 0) },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: (s: string) => `hash(${s})` }));
vi.mock("@/lib/app-settings", () => ({ isApiGloballyEnabled: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/issue-token", () => ({
  issueApiToken: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { issueApiToken } from "@/lib/auth/issue-token";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mcp/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
  vi.mocked(issueApiToken).mockResolvedValue({
    token: "hlk_abc",
    tokenId: "tok-1",
    name: "n",
    expiresAt: new Date(),
  } as never);
});

describe("POST /api/mcp/tokens — fresh proof", () => {
  it("refuses a browser session with no recent sign-in or re-proof", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      mfaVerifiedAt: null,
      reproofAt: null,
    } as never);
    const res = await POST(postReq({ name: "laptop" }));
    expect(res.status).toBe(401);
    expect((await res.json()).meta.errorCode).toBe("auth.reproof.required");
    expect(issueApiToken).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp/tokens — scope minting", () => {
  it("defaults to read-only [health:read]", async () => {
    const res = await POST(postReq({ name: "laptop" }));
    expect(res.status).toBe(201);
    expect(issueApiToken).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ["health:read"] }),
    );
  });

  it("mints read+write when scope=read_write", async () => {
    const res = await POST(postReq({ name: "laptop", scope: "read_write" }));
    expect(res.status).toBe(201);
    expect(issueApiToken).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: ["health:read", "health:write"],
      }),
    );
  });

  it("rejects any scope outside the closed set (no wildcard path)", async () => {
    for (const bad of ["*", "admin", "health:write", "write", "read_admin"]) {
      vi.mocked(issueApiToken).mockClear();
      const res = await POST(postReq({ name: "x", scope: bad }));
      expect(res.status).toBe(422);
      expect(issueApiToken).not.toHaveBeenCalled();
    }
  });

  it("never mints a wildcard for any input", async () => {
    await POST(postReq({ name: "a" }));
    await POST(postReq({ name: "b", scope: "read_write" }));
    for (const call of vi.mocked(issueApiToken).mock.calls) {
      expect(call[0].permissions).not.toContain("*");
    }
  });
});
