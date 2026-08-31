/**
 * The measurement-ingest mint.
 *
 * The assertion that matters most is not the 201 — it is the exact
 * `permissions` array handed to `issueApiToken`. That helper defaults to
 * `["*"]` when the property is absent, so an edit that drops one line turns a
 * user-facing endpoint into a cookie-equivalent credential factory, and a test
 * that only checked the status code would go on passing. The structural guard
 * catches a literal `permissions: ["*"` and would not catch the omission, so
 * this is where that hole is closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/auth/issue-token", () => ({
  issueApiToken: vi.fn(),
}));

vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

import { POST } from "../route";
import { requireAuth } from "@/lib/api-handler";
import { issueApiToken } from "@/lib/auth/issue-token";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";

const USER = { id: "user-1", role: "USER" as const };
const EXPIRES = new Date("2027-08-31T00:00:00.000Z");

function req(body: unknown): Request {
  return new Request("https://health.example/api/tokens/measurements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ user: USER } as never);
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  vi.mocked(issueApiToken).mockResolvedValue({
    token: "hlk_" + "a".repeat(64),
    expiresAt: EXPIRES,
    tokenId: "token-1",
    name: "Home Assistant",
  } as never);
});

describe("what it mints", () => {
  it("names exactly the ingest scope, and no wildcard", async () => {
    const res = await POST(req({ name: "Home Assistant" }) as never);
    expect(res.status).toBe(201);

    const opts = vi.mocked(issueApiToken).mock.calls[0][0];
    // Exact equality, not `toContain`: an extra scope is a widening, and this
    // is the assertion standing between the endpoint and one.
    expect(opts.permissions).toEqual([MEASUREMENTS_WRITE_SCOPE]);
    expect(opts.userId).toBe(USER.id);
  });

  it("returns the raw token once, with its name and expiry", async () => {
    const res = await POST(req({ name: "Home Assistant" }) as never);
    const json = await res.json();
    expect(json.data.token).toMatch(/^hlk_[0-9a-f]{64}$/);
    expect(json.data.name).toBe("Home Assistant");
    expect(json.data.expiresAt).toBeDefined();
  });

  it("expires by default rather than living forever", async () => {
    await POST(req({ name: "Scale" }) as never);
    const opts = vi.mocked(issueApiToken).mock.calls[0][0];
    expect(opts.expiresInDays).toBe(365);
  });

  it("honours an explicit lifetime", async () => {
    await POST(req({ name: "Scale", expiresInDays: 30 }) as never);
    expect(vi.mocked(issueApiToken).mock.calls[0][0].expiresInDays).toBe(30);
  });

  it("audits the mint with the token id and the scope", async () => {
    await POST(req({ name: "Scale" }) as never);
    expect(auditLog).toHaveBeenCalledWith(
      "tokens.measurements.create",
      expect.objectContaining({
        userId: USER.id,
        details: expect.objectContaining({
          tokenId: "token-1",
          scope: MEASUREMENTS_WRITE_SCOPE,
        }),
      }),
    );
  });
});

describe("when it refuses", () => {
  it("403s while the operator has the API switched off", async () => {
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);
    const res = await POST(req({ name: "Scale" }) as never);
    expect(res.status).toBe(403);
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("429s past the mint rate limit, without minting", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await POST(req({ name: "Scale" }) as never);
    expect(res.status).toBe(429);
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("422s on a missing name", async () => {
    const res = await POST(req({}) as never);
    expect(res.status).toBe(422);
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("422s on a lifetime outside the permitted band", async () => {
    const res = await POST(
      req({ name: "Scale", expiresInDays: 4000 }) as never,
    );
    expect(res.status).toBe(422);
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("ignores a scope the body tries to smuggle in", async () => {
    // There is no `scope` field to validate, so an unknown key is simply not
    // read — the permission array is a literal either way. Asserted because
    // "the field does not exist" is the security property, and a schema change
    // that added one would silently make this body meaningful.
    await POST(
      req({ name: "Scale", scope: "read_write", permissions: ["*"] }) as never,
    );
    expect(vi.mocked(issueApiToken).mock.calls[0][0].permissions).toEqual([
      MEASUREMENTS_WRITE_SCOPE,
    ]);
  });
});
