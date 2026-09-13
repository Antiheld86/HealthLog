/**
 * POST /api/settings/email/test — a failed send names its cause.
 *
 * Before this the route answered every failure with a bare 500, so the card
 * read "Test failed" whether the mail server refused the login, timed out,
 * or rejected the recipient.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { notificationChannel: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));
const sendViaEmailMock = vi.fn();
vi.mock("@/lib/notifications/senders/email", () => ({
  sendViaEmail: (...args: unknown[]) => sendViaEmailMock(...args),
}));
vi.mock("@/lib/notifications/senders/email-config", () => ({
  isEmailConfigured: () => true,
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../email/test/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function post(): Promise<Response> {
  return (POST as (request: Request) => Promise<Response>)(
    new Request("http://localhost/api/settings/email/test", {
      method: "POST",
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue({
    config: 'encrypted:{"recipient":"you@example.com"}',
  } as never);
});

describe("POST /api/settings/email/test", () => {
  it.each([
    ["credentials_rejected", 535, "rejected the credentials (SMTP 535)"],
    ["upstream_rejected", 550, "refused the message (SMTP 550)"],
  ])(
    "answers an SMTP rejection with 502, %s and the reply code",
    async (failureCode, smtpCode, sentence) => {
      sendViaEmailMock.mockResolvedValue({
        ok: false,
        hardReject: smtpCode >= 500,
        reason: "email_smtp_5xx",
        failureCode,
        smtpCode,
      });

      const response = await post();

      expect(response.status).toBe(502);
      const json = await response.json();
      expect(json.meta).toEqual({ errorCode: failureCode, smtpCode });
      expect(json.error).toContain(sentence);
    },
  );

  it("answers a timeout with 502 and the timeout code", async () => {
    sendViaEmailMock.mockResolvedValue({
      ok: false,
      hardReject: false,
      reason: "email_smtp_error",
      failureCode: "timeout",
    });

    const response = await post();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      meta: { errorCode: "timeout" },
    });
  });

  it("keeps a 500 for a failure the sender could not name", async () => {
    sendViaEmailMock.mockResolvedValue({
      ok: false,
      hardReject: false,
      reason: "email_smtp_error",
    });

    const response = await post();

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.meta).toBeUndefined();
  });

  it("answers a delivered test with 200", async () => {
    sendViaEmailMock.mockResolvedValue({ ok: true });

    const response = await post();

    expect(response.status).toBe(200);
  });
});
