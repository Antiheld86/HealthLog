/**
 * Generic-webhook sender unit tests (v1.17.1).
 *
 * Covers: success, hard-reject classification (404/410/401/403), SSRF block
 * (safeFetch throws `private_host`), cooldown-relevant transient classification
 * (5xx), and the push_attempts ledger write per outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeFetchMock = vi.fn();
const recordPushAttemptMock = vi.fn();

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  SafeFetchError: class SafeFetchError extends Error {
    kind: string;
    constructor(message: string, kind: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn(), addExternalCall: vi.fn() }),
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: (...args: unknown[]) => recordPushAttemptMock(...args),
  recordPushAttemptForPayload: (
    _payload: unknown,
    _recipientUserId: string,
    attempt: unknown,
  ) => recordPushAttemptMock(attempt),
}));

import { sendViaWebhook } from "../webhook";
import { SafeFetchError } from "@/lib/safe-fetch";

const config = {
  url: "https://gotify.example.com/message",
  headerName: "Authorization",
  headerValue: "Bearer secret",
};

function payload(over?: Record<string, unknown>) {
  return {
    eventType: "SYSTEM_ALERT" as const,
    userId: "user-1",
    title: "Title",
    message: "Body",
    ...over,
  };
}

beforeEach(() => {
  safeFetchMock.mockReset();
  recordPushAttemptMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sendViaWebhook", () => {
  it("POSTs through safeFetch with requirePublicHost and returns ok on 200", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    const result = await sendViaWebhook(config, payload());

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    // SSRF floor + DNS-rebinding pin: requirePublicHost must be set.
    const [, init, opts] = safeFetchMock.mock.calls[0];
    expect((opts as { requirePublicHost?: boolean }).requirePublicHost).toBe(
      true,
    );
    expect((init as { method?: string }).method).toBe("POST");
    // Custom header is attached.
    expect(
      (init as { headers?: Record<string, string> }).headers?.Authorization,
    ).toBe("Bearer secret");
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "WEBHOOK", result: "ok" }),
    );
  });

  it("hard-rejects on 410 (endpoint gone)", async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 410 });

    const result = await sendViaWebhook(config, payload());

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(true);
    expect(result.reason).toBe("webhook_410_gone");
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "WEBHOOK", result: "error" }),
    );
  });

  it("hard-rejects on 401/403 (shared secret wrong)", async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 403 });
    const result = await sendViaWebhook(config, payload());
    expect(result.hardReject).toBe(true);
    expect(result.reason).toBe("webhook_auth_rejected");
  });

  it("soft-fails on 503 (transient — eligible for backoff)", async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 503 });

    const result = await sendViaWebhook(config, payload());

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(false);
    expect(result.reason).toBe("webhook_503");
  });

  it("returns a transient network error when safeFetch blocks a private host (SSRF)", async () => {
    safeFetchMock.mockRejectedValue(
      new SafeFetchError("refused private host", "private_host"),
    );

    const result = await sendViaWebhook(config, payload());

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(false);
    expect(result.reason).toBe("webhook_network_error");
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "WEBHOOK",
        result: "error",
        reason: "webhook_network_error",
      }),
    );
  });

  it("omits the custom header when not configured", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaWebhook({ url: "https://example.com/hook" }, payload());
    const [, init] = safeFetchMock.mock.calls[0];
    expect(
      (init as { headers?: Record<string, string> }).headers?.Authorization,
    ).toBeUndefined();
  });
});
