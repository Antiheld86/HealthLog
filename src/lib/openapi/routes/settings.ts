/**
 * OpenAPI route table — settings read surfaces and the per-channel
 * notification config under `/api/settings/*`.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  notificationChannelEnabledSchema,
  ntfySettingsSchema,
  webhookSettingsSchema,
} from "@/lib/validations/notifications";
import { telegramSettingsSchema } from "@/lib/validations/telegram";
import {
  dataEnvelope,
  errorEnvelope,
  recordRefusal,
  stdResponses,
} from "./shared";

// v1.16.11 — the one threshold read every dose-status consumer makes
// (cards, table, take-all-due derivation). `lateMinutes` /
// `missedMinutes` are the operator-level singleton; the low-stock
// runway threshold rides along but is PER-USER (written through
// `PATCH /api/auth/me/notification-prefs`).
const reminderThresholdsResponse = z
  .object({
    lateMinutes: z
      .number()
      .int()
      .describe(
        "Minutes after the dose anchor at which an open dose tiers 'late' (operator-level singleton; default 120).",
      ),
    missedMinutes: z
      .number()
      .int()
      .describe(
        "Minutes after the dose anchor at which an open dose tiers 'missed' (operator-level singleton; default 240).",
      ),
    lowStockRunwayDays: z
      .number()
      .int()
      .min(1)
      .max(60)
      .nullable()
      .describe(
        "Per-user low-stock alert threshold as remaining runway days (1–60). null = the alert is off. Default 7. Written via PATCH /api/auth/me/notification-prefs.",
      ),
    reorderLeadDays: z
      .number()
      .int()
      .min(0)
      .max(60)
      .describe(
        "v1.17.0 — per-user reorder lead default in days (0–60, default 10). The low-stock alert fires this lead plus one dose-interval before the supply runs out so a refill arrives before the last dose; a per-medication reorderLeadDays overrides it. Written via PATCH /api/auth/me/notification-prefs.",
      ),
  })
  .meta({
    id: "ReminderThresholdsResponse",
    description:
      "Medication reminder thresholds: the operator-level late/missed minute marks plus the calling user's low-stock runway threshold (v1.16.11).",
  });

// ── Per-channel notification config ──────────────────────────────────
// Three credential-bearing channels the Settings page and the iOS client both
// write. Every GET here reports the SECRET AS A BOOLEAN and never the value:
// `hasAuthToken` (ntfy), `hasBotToken` (Telegram), `hasHeaderValue` (webhook).
// The PUT side is what that costs: because a client cannot read the secret back,
// an empty value on the way in means "keep what is stored", never "clear it".

const jsonBodyRefusals = {
  "400": {
    description: "Body is not parseable JSON.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "413": {
    description: "Body exceeds 64 KiB.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "415": {
    description: "Content-Type is not `application/json`.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const channelEnabledOnlyRequest = notificationChannelEnabledSchema.meta({
  id: "NotificationChannelEnabledRequest",
  description:
    "The toggle-only arm of a channel PUT: exactly `{ enabled }` and nothing else. Any additional key falls through to the channel's full config body instead. Enabling a channel whose stored config is incomplete fails with 422.",
});

const ntfySettingsRequest = ntfySettingsSchema.meta({
  id: "NtfySettingsRequest",
  description:
    "ntfy channel config. `serverUrl` must pass the SSRF floor — a URL resolving into a private range is refused at input time. An EMPTY OR OMITTED `authToken` preserves the stored one rather than clearing it: the GET never returns the secret, so a client round-tripping the form would otherwise wipe it on every unrelated save. Sending a non-empty value replaces it. There is no way to clear a stored auth token through this endpoint.",
});

const telegramSettingsRequest = telegramSettingsSchema.meta({
  id: "TelegramSettingsRequest",
  description:
    "Telegram channel config. Both credential fields are optional and behave by key PRESENCE, not by value: omit `botToken` to keep the stored one, send an empty string to clear it. Same for `chatId`. Enabling the channel registers the Telegram webhook against `APP_URL` as part of the write, so a deployment whose `APP_URL` is not a public HTTPS host on port 80/88/443/8443 cannot enable Telegram at all.",
});

const webhookSettingsRequest = webhookSettingsSchema.meta({
  id: "WebhookSettingsRequest",
  description:
    "Generic-webhook channel config — one channel covering Gotify, Discord, Slack, a Matrix bridge, Home Assistant, or any relay accepting an inbound JSON POST. `url` must pass the SSRF floor at input time and is re-checked at dispatch time. An EMPTY OR OMITTED `headerValue` preserves the stored one, for the same reason as ntfy's `authToken`: the GET never returns it. There is no way to clear a stored header value through this endpoint.",
});

/**
 * The two shapes every channel PUT accepts, as one `anyOf`.
 *
 * The handler tries the strict `{ enabled }` object first and falls through to
 * the full config schema, so the wire genuinely admits either. Publishing only
 * the full schema would tell a client it has to resend the whole config to flip
 * a toggle — exactly the round-trip the preserve-on-empty rule exists to
 * survive, and exactly the round-trip that used to wipe the stored secret.
 */
const ntfyPutRequest = z
  .union([channelEnabledOnlyRequest, ntfySettingsRequest])
  .meta({
    id: "NtfySettingsPutRequest",
    description:
      "Either the toggle-only body or the full ntfy config. The toggle arm is tried first and matches only an object with `enabled` and no other key.",
  });

const telegramPutRequest = z
  .union([channelEnabledOnlyRequest, telegramSettingsRequest])
  .meta({
    id: "TelegramSettingsPutRequest",
    description:
      "Either the toggle-only body or the full Telegram config. The toggle arm is tried first and matches only an object with `enabled` and no other key.",
  });

const webhookPutRequest = z
  .union([channelEnabledOnlyRequest, webhookSettingsRequest])
  .meta({
    id: "WebhookSettingsPutRequest",
    description:
      "Either the toggle-only body or the full webhook config. The toggle arm is tried first and matches only an object with `enabled` and no other key.",
  });

const ntfySettingsResponse = z
  .object({
    enabled: z.boolean(),
    serverUrl: z
      .string()
      .describe("Defaults to `https://ntfy.sh` when no channel row exists."),
    topic: z.string().describe("Empty string when unset."),
    hasAuthToken: z
      .boolean()
      .describe(
        "Whether an auth token is stored. The token itself is never returned.",
      ),
  })
  .meta({
    id: "NtfySettingsResponse",
    description:
      "Stored ntfy channel config, with the auth token reduced to a presence flag.",
  });

const telegramSettingsResponse = z
  .object({
    enabled: z.boolean(),
    hasBotToken: z
      .boolean()
      .describe(
        "Whether a bot token is stored. The token itself is never returned.",
      ),
    chatId: z
      .string()
      .nullable()
      .describe(
        "The stored chat id, returned in full. It is an addressing value, not a credential — the bot token is what authorises a send.",
      ),
  })
  .meta({
    id: "TelegramSettingsResponse",
    description:
      "Stored Telegram channel config, with the bot token reduced to a presence flag.",
  });

const webhookSettingsResponse = z
  .object({
    enabled: z.boolean(),
    url: z.string().describe("Empty string when no channel row exists."),
    headerName: z
      .string()
      .describe("Empty string when unset. The header NAME is not a secret."),
    hasHeaderValue: z
      .boolean()
      .describe(
        "Whether a header value (the shared secret) is stored. The value itself is never returned.",
      ),
  })
  .meta({
    id: "WebhookSettingsResponse",
    description:
      "Stored generic-webhook channel config, with the secret header value reduced to a presence flag.",
  });

const channelSaved = z.object({ saved: z.literal(true) });
const channelUpdated = z.object({ updated: z.literal(true) });

export const settingsPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/settings/reminder-thresholds": {
    get: {
      tags: ["Notifications"],
      summary: "Read the medication reminder thresholds",
      description:
        "Returns the operator-level late/missed minute thresholds that tier an open dose's status, plus the calling user's low-stock runway threshold (days; null = alert off). One endpoint so every threshold consumer reads one shape. Auth via cookie or Bearer.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Resolved thresholds.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                reminderThresholdsResponse,
                "GetReminderThresholdsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/settings/ntfy": {
    get: {
      tags: ["Notifications"],
      summary: "Read the caller's ntfy channel config",
      description:
        'Returns the stored server URL, topic and enabled flag. The auth token is reported as `hasAuthToken` only. When the user has no ntfy channel row the defaults `{ enabled: false, serverUrl: "https://ntfy.sh", topic: "", hasAuthToken: false }` are returned rather than a 404. Auth via cookie or Bearer.',
      responses: {
        "200": {
          description: "Stored (or default) ntfy config.",
          content: {
            "application/json": {
              schema: dataEnvelope(ntfySettingsResponse, "GetNtfySettings"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Notifications"],
      summary: "Update the caller's ntfy channel config",
      description:
        "Upserts the channel. Accepts either the toggle-only body or the full config. The response is `{ saved: true }` and carries no config echo, so re-read the GET if the client needs the resolved state. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: ntfyPutRequest } },
      },
      responses: {
        "200": {
          description: "Config stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(channelSaved, "PutNtfySettingsResponse"),
            },
          },
        },
        ...jsonBodyRefusals,
        ...stdResponses,
        "422": {
          description:
            "Body matched neither accepted shape, or `enabled` is true while the stored config has no server URL and topic.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/settings/telegram": {
    get: {
      tags: ["Notifications"],
      summary: "Read the caller's Telegram channel config",
      description:
        "Returns the enabled flag, the chat id and `hasBotToken`. The bot token is never returned. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Stored Telegram config.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                telegramSettingsResponse,
                "GetTelegramSettings",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Notifications"],
      summary: "Update the caller's Telegram channel config",
      description:
        "Accepts either the toggle-only body or the full config, then registers (on enable) or deletes (on disable) the Telegram webhook for the bot before persisting. Webhook deletion is best-effort and its failure does not fail the write; webhook REGISTRATION is not — a rejected registration aborts the whole call and nothing is stored. The response is `{ updated: true }` with no config echo. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: telegramPutRequest } },
      },
      responses: {
        "200": {
          description: "Config stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                channelUpdated,
                "PutTelegramSettingsResponse",
              ),
            },
          },
        },
        "404": {
          description: "The session's user row no longer exists.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...jsonBodyRefusals,
        "500": {
          description:
            "The deployment cannot register a Telegram webhook because `APP_URL` (or `NEXT_PUBLIC_APP_URL`) is missing or unparseable. An operator configuration problem, not a client one — retrying will not help.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "Body matched neither accepted shape; or `enabled` is true without both a bot token and a chat id; or the deployment's `APP_URL` is not a public HTTPS host on port 80/88/443/8443; or Telegram refused the webhook registration.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/settings/webhook": {
    get: {
      tags: ["Notifications"],
      summary: "Read the caller's generic-webhook channel config",
      description:
        'Returns the stored URL, header name and enabled flag. The secret header value is reported as `hasHeaderValue` only. When the user has no webhook channel row the defaults `{ enabled: false, url: "", headerName: "", hasHeaderValue: false }` are returned rather than a 404. Auth via cookie or Bearer.',
      responses: {
        "200": {
          description: "Stored (or default) webhook config.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webhookSettingsResponse,
                "GetWebhookSettings",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Notifications"],
      summary: "Update the caller's generic-webhook channel config",
      description:
        "Upserts the channel. Accepts either the toggle-only body or the full config. The response is `{ saved: true }` and carries no config echo. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: webhookPutRequest } },
      },
      responses: {
        "200": {
          description: "Config stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(channelSaved, "PutWebhookSettingsResponse"),
            },
          },
        },
        ...jsonBodyRefusals,
        ...stdResponses,
        "422": {
          description:
            "Body matched neither accepted shape, or `enabled` is true while no webhook URL is stored.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
