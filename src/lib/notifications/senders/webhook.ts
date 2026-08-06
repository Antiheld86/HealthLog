import type {
  WebhookChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyHttpStatus } from "@/lib/notifications/retry-policy";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttemptForPayload } from "@/lib/notifications/senders/push-attempt-record";
import { safeFetch } from "@/lib/safe-fetch";
import { plainPushText } from "@/lib/notifications/strip-emoji";

/**
 * Send a notification via a generic outbound webhook (v1.17.1).
 *
 * The user supplies a public URL (and optionally one custom header — e.g.
 * `Authorization: Bearer <token>` for Gotify). We POST a small JSON envelope
 * that Gotify / Discord / Slack / Matrix-bridge / Home Assistant / any homelab
 * relay can consume. The body is plain text (no markdown — hard rule); the
 * `title`/`message` fields are stripped of HTML + decorative emoji on routine
 * reminders exactly like the ntfy sender.
 *
 * Outbound goes through `safeFetch({ requirePublicHost: true })`: the SSRF
 * floor plus the connect-time DNS-rebinding pin apply because the host is
 * user-supplied. The optional shared-secret header would otherwise leak on a
 * rebinding flip to a private address.
 *
 * Returns a `SendOutcome` so the dispatcher can distinguish hard rejects
 * (404/410 endpoint gone, 401/403 secret wrong) from soft errors (5xx, 429,
 * network timeout) and apply the right retry / auto-disable policy.
 */
export async function sendViaWebhook(
  config: WebhookChannelConfig,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  const userId = payload.recipientUserId ?? payload.userId;
  const start = performance.now();
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.headerName && config.headerValue) {
      headers[config.headerName] = config.headerValue;
    }

    // Plain-text envelope. The `title` field doubles as Gotify's `title` and
    // Discord/Slack ignore unknown keys, so a single shape covers the common
    // relays. Discreet mode (cycle privacy) is honoured by the title/body
    // already being masked upstream; we also send a generic `eventType` tag so
    // a relay rule can route without leaking the cycle event name.
    const body = JSON.stringify({
      title: plainPushText(payload.title, payload.eventType),
      message: plainPushText(
        payload.message.replace(/<[^>]*>/g, ""),
        payload.eventType,
      ),
      eventType: payload.discreet ? "reminder" : payload.eventType,
      // v1.18.4 — an explicitly urgent event maps to `urgent` so a relay
      // rule (Gotify priority, Discord mention, Home Assistant automation)
      // can escalate; MEDICATION_REMINDER keeps `high`; the rest `default`.
      priority:
        payload.urgent === true
          ? "urgent"
          : payload.eventType === "MEDICATION_REMINDER"
            ? "high"
            : "default",
    });

    const res = await safeFetch(
      config.url,
      {
        method: "POST",
        headers,
        body,
      },
      { timeoutMs: 5_000, requirePublicHost: true },
    );

    getEvent()?.addExternalCall({
      service: "webhook",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      status: res.status,
    });

    if (res.ok) {
      recordPushAttemptForPayload(payload, userId, {
        userId: payload.userId,
        channel: "WEBHOOK",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true, statusCode: res.status };
    }
    const classified = classifyHttpStatus(res.status, "webhook");
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "WEBHOOK",
      eventType: payload.eventType,
      result: "error",
      reason: classified.reason,
    });
    return {
      ok: false,
      statusCode: res.status,
      hardReject: classified.hardReject,
      reason: classified.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "request_failed";
    getEvent()?.addExternalCall({
      service: "webhook",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      error: message,
    });
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "WEBHOOK",
      eventType: payload.eventType,
      result: "error",
      reason: "webhook_network_error",
    });
    return {
      ok: false,
      hardReject: false,
      reason: "webhook_network_error",
      message,
    };
  }
}
