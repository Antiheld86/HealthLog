/**
 * Adding a credential to an account that already has a second factor.
 *
 * A password, a young session or a password re-proof used to be enough to
 * add a security key, a TOTP authenticator or a passkey even when the account
 * was protected by a second factor. A session that signed in on a remembered
 * browser skips the factor and is still young, so the password alone could
 * add a key that then satisfies every gate the factor protected. On such an
 * account only possession of a factor counts now; the account without one is
 * unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    session: { findUnique: vi.fn(), update: vi.fn() },
    webauthnMfaCredential: { count: vi.fn() },
    passkey: { count: vi.fn() },
    authChallenge: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
  refundRateLimit: vi.fn(),
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/password", () => ({ verifyPassword: vi.fn() }));
vi.mock("@/lib/auth/passkey", () => ({
  verifyAuthentication: vi.fn(),
  createAuthenticationOptions: vi.fn(),
  createRegistrationOptions: vi.fn(),
}));
vi.mock("@/lib/auth/mfa/webauthn", () => ({
  verifyMfaAuthentication: vi.fn(),
  createMfaAuthenticationOptions: vi.fn(),
}));
vi.mock("@/lib/auth/mfa/verify-factor", () => ({ verifyMfaFactor: vi.fn() }));
vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  requireCookieAuth: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { checkRateLimit, refundRateLimit } from "@/lib/rate-limit";
import { verifyPassword } from "@/lib/auth/password";
import { verifyMfaFactor } from "@/lib/auth/mfa/verify-factor";
import { createRegistrationOptions } from "@/lib/auth/passkey";
import { requireCookieAuth } from "@/lib/api-handler";
import { checkCookieEnrollmentProof } from "../existing-factor-proof";
import { POST as PASSKEY_REGISTER_OPTIONS } from "@/app/api/auth/passkey/register-options/route";

const NOW = Date.now();
const fresh = new Date(NOW - 60_000);
const stale = new Date(NOW - 60 * 60_000);

const ENROLLED: {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  totpSecretEncrypted: string | null;
  totpLastStep: null;
  totpConfirmedAt: Date | null;
} = {
  id: "user-1",
  username: "u",
  email: "u@example.com",
  passwordHash: "hash",
  totpSecretEncrypted: "enc",
  totpLastStep: null,
  totpConfirmedAt: new Date("2026-01-01"),
};
const PLAIN = { ...ENROLLED, totpSecretEncrypted: null, totpConfirmedAt: null };

function req(body?: unknown): Request {
  return new Request("http://localhost/api/auth/me/mfa/totp/setup", {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function session(stamps: {
  mfaVerifiedAt?: Date | null;
  createdAt?: Date;
  reproofAt?: Date | null;
}) {
  vi.mocked(prisma.session.findUnique).mockResolvedValue({
    mfaVerifiedAt: stamps.mfaVerifiedAt ?? null,
    createdAt: stamps.createdAt ?? stale,
    reproofAt: stamps.reproofAt ?? null,
  } as never);
}

function gate(user: typeof ENROLLED | typeof PLAIN, request: Request) {
  return checkCookieEnrollmentProof({
    user: user as never,
    sessionId: "sess-1",
    request,
    ipAddress: "203.0.113.9",
    stage: "totp_enroll",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.passkey.count).mockResolvedValue(0 as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 5,
    remaining: 4,
    resetAt: NOW + 1000,
  });
});

describe("account with a second factor", () => {
  it("a session signed in a minute ago is not enough (remembered browser)", async () => {
    session({ createdAt: fresh });
    const res = await gate(ENROLLED, req());
    expect(res?.status).toBe(401);
    const body = await res!.json();
    expect(body.meta.errorCode).toBe("auth.reproof.required");
    expect(body.meta.methods).toEqual(["totp"]);
  });

  it("a password re-proof stamp is not enough", async () => {
    session({ reproofAt: fresh });
    const res = await gate(ENROLLED, req());
    expect(res?.status).toBe(401);
  });

  it("a password in the body is refused before it is verified", async () => {
    session({ createdAt: fresh });
    const res = await gate(
      ENROLLED,
      req({ method: "password", password: "correct horse" }),
    );
    expect(res?.status).toBe(401);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("a completed second factor within five minutes passes", async () => {
    session({ mfaVerifiedAt: fresh });
    expect(await gate(ENROLLED, req())).toBeNull();
  });

  it("a TOTP code in the body passes and gives the attempt back", async () => {
    session({});
    vi.mocked(verifyMfaFactor).mockResolvedValue({ ok: true } as never);
    expect(await gate(ENROLLED, req({ method: "totp", code: "123456" }))).toBe(
      null,
    );
    expect(refundRateLimit).toHaveBeenCalledWith("auth:step-up:user-1");
  });

  it("a security key alone makes the account enrolled", async () => {
    vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(1 as never);
    session({ createdAt: fresh });
    const res = await gate(PLAIN, req());
    expect(res?.status).toBe(401);
    expect((await res!.json()).meta.methods).toEqual(["webauthn"]);
  });
});

describe("account without a second factor (unchanged)", () => {
  it("a session signed in a minute ago passes", async () => {
    session({ createdAt: fresh });
    expect(await gate(PLAIN, req())).toBeNull();
  });

  it("a password in the body passes", async () => {
    session({});
    vi.mocked(verifyPassword).mockResolvedValue(true);
    expect(
      await gate(PLAIN, req({ method: "password", password: "pw" })),
    ).toBeNull();
    expect(verifyPassword).toHaveBeenCalled();
  });
});

describe("POST /api/auth/passkey/register-options", () => {
  function passkeyReq(body: unknown) {
    return new Request("http://localhost/api/auth/passkey/register-options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("refuses a password on an account with a second factor, before verifying it", async () => {
    vi.mocked(requireCookieAuth).mockResolvedValue({
      user: ENROLLED,
      session: { id: "sess-1" },
    } as never);
    const res = await PASSKEY_REGISTER_OPTIONS(
      passkeyReq({ method: "password", password: "correct horse" }) as never,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.meta.errorCode).toBe("auth.reproof.too_weak");
    expect(body.meta.methods).toEqual(["totp"]);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(createRegistrationOptions).not.toHaveBeenCalled();
  });

  it("still takes a password on an account without one", async () => {
    vi.mocked(requireCookieAuth).mockResolvedValue({
      user: PLAIN,
      session: { id: "sess-1" },
    } as never);
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(createRegistrationOptions).mockResolvedValue({
      options: {},
      challengeId: "ch-1",
    } as never);
    const res = await PASSKEY_REGISTER_OPTIONS(
      passkeyReq({ method: "password", password: "pw" }) as never,
    );
    expect(res.status).toBe(200);
    expect(refundRateLimit).toHaveBeenCalledWith("auth:step-up:user-1");
  });
});
