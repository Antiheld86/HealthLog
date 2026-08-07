/**
 * OpenAPI route table — settings read surfaces.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { dataEnvelope, recordRefusal, stdResponses } from "./shared";

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
};
