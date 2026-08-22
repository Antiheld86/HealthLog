/**
 * OpenAPI route table — settings surfaces: the reminder thresholds, the
 * operator's instance-wide service switches, and account deletion.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
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

// ── Instance-level service switches ──────────────────────────────────

const globalServiceAvailabilityResponse = z
  .object({
    telegramGlobal: z.boolean().describe("Telegram notifications are offered."),
    ntfyGlobal: z.boolean().describe("ntfy notifications are offered."),
    webPushGlobal: z.boolean().describe("Web Push is offered."),
    apiGlobal: z
      .boolean()
      .describe(
        "The API-token surface is on. When false, `/api/tokens` and its revoke sibling answer 403 — the read included.",
      ),
  })
  .meta({
    id: "GlobalServiceAvailability",
    description:
      "Which optional services the operator has left switched on instance-wide. Every flag defaults to true, and a failed settings read returns all-true rather than an error, so a client must not treat this as proof a channel is configured — only that the operator has not switched it off.",
  });

// ── Account deletion ─────────────────────────────────────────────────
// The body is hand-parsed rather than Zod-validated (the handler reads the raw
// text, caps it, and compares one field), so the shape is described here rather
// than imported. Documenting it as a schema is still right: it is the wire
// contract, whatever the handler uses to check it.

const deleteAccountRequest = z
  .object({
    confirm: z
      .literal("DELETE_ACCOUNT")
      .describe(
        "The literal string `DELETE_ACCOUNT`. Any other value, and any non-string, is refused with 422.",
      ),
  })
  .meta({
    id: "DeleteAccountRequest",
    description:
      "Typed confirmation for permanent account deletion. There is no second step and no undo.",
  });

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
  // ── Appended: two settings surfaces the registry never carried.
  "/api/settings/global-services": {
    get: {
      tags: ["Notifications"],
      summary: "Read the operator's instance-wide service switches",
      description:
        "Which optional services this instance offers at all, so a client can hide a channel the operator has switched off rather than let a user configure something that will never deliver. Auth via cookie or a wildcard Bearer token; the answer is about the DEPLOYMENT and is identical for every account on it.\n\n" +
        "Reads fail soft: when the settings row cannot be loaded the handler returns all-true rather than an error, so a true flag means “not switched off”, never “configured and working”.",
      responses: {
        "200": {
          description: "The instance's service switches.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                globalServiceAvailabilityResponse,
                "GlobalServiceAvailabilityEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/settings/account": {
    delete: {
      tags: ["Auth"],
      summary: "Permanently delete the account and everything in it",
      description:
        "Erasure, not deactivation: the user row goes, every related row cascades with it, and the account's own audit history — IP addresses, login geo — is purged inside the same transaction rather than being left orphaned. There is no undo and no grace period.\n\n" +
        "Two gates, and they compose. The body must carry the typed confirmation. And for an account with a second factor enrolled — a confirmed TOTP secret OR a registered security key — the session must additionally carry a fresh factor proof, which is cookie-only by construction: a Bearer transport carries no `mfaVerifiedAt` and therefore cannot satisfy it at any scope. An account with NO second factor keeps the typed-confirmation-only contract on either transport, deliberately, because a user who never enrolled has no ceremony to complete.\n\n" +
        "Two refusals are not about the caller's credentials at all. The last remaining admin cannot delete themselves, and the last Guardian of a managed profile cannot leave that profile unattended.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: deleteAccountRequest } },
      },
      responses: {
        "200": {
          description: "Account and all associated data deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteAccountEnvelope",
              ),
            },
          },
        },
        "400": {
          description:
            "This is the last admin account on the instance and cannot be deleted. Promote another admin first.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The caller is the last Guardian of a managed profile (`meta.errorCode` = `managed_profile.guardian.required`). Add another Guardian, or delete the managed profile, before deleting this account. Nothing was deleted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Request body exceeds 65536 bytes. Nothing was deleted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "401": {
          description:
            "Not authenticated — or the account has a second factor and the session carries no proof of it fresh enough for a destructive action (`meta.errorCode` = `auth.stepup.required`, or `auth.stepup.mfa_not_enrolled`). Re-verify the factor on the web and retry; a Bearer token cannot clear this arm.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
