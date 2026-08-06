/**
 * SMTP / email sender unit tests (v1.17.1).
 *
 * Covers: success, transient SMTP failure (4xx/connection — backoff-eligible),
 * hard reject (5xx permanent — channel auto-disables), the "SMTP not
 * configured" soft-skip, the "no recipient" soft-skip, and the ledger write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMailMock = vi.fn();
const createTransportMock = vi.fn((options: unknown) => {
  void options;
  return { sendMail: sendMailMock };
});
const loadEmailConfigMock = vi.fn();
const recordPushAttemptMock = vi.fn();

vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: unknown) => createTransportMock(options),
  },
}));

vi.mock("@/lib/notifications/senders/email-config", () => ({
  loadEmailConfig: () => loadEmailConfigMock(),
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

import { sendViaEmail, resetEmailTransporterForTesting } from "../email";

const transport = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  from: "HealthLog <noreply@example.com>",
  auth: { user: "u", pass: "p" },
};

function payload(over?: Record<string, unknown>) {
  return {
    eventType: "SYSTEM_ALERT" as const,
    userId: "user-1",
    title: "Subject",
    message: "<b>Body</b>",
    ...over,
  };
}

beforeEach(() => {
  sendMailMock.mockReset();
  createTransportMock.mockClear();
  loadEmailConfigMock.mockReset();
  recordPushAttemptMock.mockReset();
  resetEmailTransporterForTesting();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sendViaEmail", () => {
  it("sends a plain-text email and returns ok", async () => {
    loadEmailConfigMock.mockReturnValue(transport);
    sendMailMock.mockResolvedValue({ messageId: "1" });

    const result = await sendViaEmail(
      { recipient: "you@example.com" },
      payload(),
    );

    expect(result.ok).toBe(true);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe("you@example.com");
    expect(mail.from).toBe(transport.from);
    // Body is plain text — HTML stripped, no `html` field.
    expect(mail.text).toBe("Body");
    expect(mail.html).toBeUndefined();
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "EMAIL", result: "ok" }),
    );
  });

  it("builds the transport with explicit SMTP timeouts (no unbounded hang)", async () => {
    loadEmailConfigMock.mockReturnValue(transport);
    sendMailMock.mockResolvedValue({ messageId: "1" });

    await sendViaEmail({ recipient: "you@example.com" }, payload());

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    const opts = createTransportMock.mock.calls[0][0] as {
      connectionTimeout?: number;
      greetingTimeout?: number;
      socketTimeout?: number;
    };
    expect(opts.connectionTimeout).toBe(10_000);
    expect(opts.greetingTimeout).toBe(10_000);
    expect(opts.socketTimeout).toBe(20_000);
  });

  it("soft-skips when SMTP is unconfigured (no channel burn)", async () => {
    loadEmailConfigMock.mockReturnValue(null);

    const result = await sendViaEmail(
      { recipient: "you@example.com" },
      payload(),
    );

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(false);
    expect(result.reason).toBe("email_not_configured");
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "EMAIL", result: "skipped" }),
    );
  });

  it("soft-skips when the recipient is empty", async () => {
    loadEmailConfigMock.mockReturnValue(transport);

    const result = await sendViaEmail({ recipient: "" }, payload());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("email_no_recipient");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("hard-rejects on an SMTP 5xx (permanent — auto-disable)", async () => {
    loadEmailConfigMock.mockReturnValue(transport);
    const err = Object.assign(new Error("550 mailbox unavailable"), {
      responseCode: 550,
    });
    sendMailMock.mockRejectedValue(err);

    const result = await sendViaEmail(
      { recipient: "you@example.com" },
      payload(),
    );

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(true);
    expect(result.reason).toBe("email_smtp_5xx");
  });

  it("soft-fails on a connection error (transient — backoff-eligible)", async () => {
    loadEmailConfigMock.mockReturnValue(transport);
    sendMailMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await sendViaEmail(
      { recipient: "you@example.com" },
      payload(),
    );

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(false);
    expect(result.reason).toBe("email_smtp_error");
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "EMAIL", result: "error" }),
    );
  });
});
