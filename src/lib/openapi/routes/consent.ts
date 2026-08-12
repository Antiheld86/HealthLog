/**
 * OpenAPI route table — AI consent receipts (v1.16.13).
 *
 * The `ConsentReceipt` family is the GDPR Art. 7 / App-Store 5.1.2(i)
 * audit trail and the precondition the server-managed AI-egress gate
 * (`src/lib/ai/consent-guard.ts`) enforces before any health snapshot
 * leaves for the operator's global LLM key. It shipped (commit 37e9f32f)
 * without a contract bump; this module documents the surface so iOS + web
 * clients have a stable reference.
 *
 * Receipt kinds: `ai_full` (master — satisfies every surface),
 * `ai_insights_only` (Insights only), `ai_coach` (Coach only).
 *
 * - POST /api/consent/ai      — explicit grant with a signed artefact (iOS).
 * - POST /api/consent/ai/web  — idempotent `ai_full` grant for the web
 *                               client. Without a body it is the AI-settings
 *                               mount heal (never lifts a revocation); with
 *                               `intent: "affirmative"` it is the explicit
 *                               grant control on the same surface.
 * - GET  /api/consent/ai/latest — latest active receipt(s).
 * - DELETE /api/consent/ai/latest — revoke the latest receipt (all kinds
 *                               when `kind` is omitted — the master OFF).
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  consentKindEnum,
  consentPostBody,
  webConsentGrantBody,
} from "@/lib/validations/consent";
import { dataEnvelope, stdResponses } from "./shared";

consentPostBody.meta({
  id: "ConsentPostBody",
  description:
    "Explicit AI-consent grant. `artefact` is an opaque signed receipt (base64 PDF or JWT, ≤ 64 KB UTF-8 bytes); `signedAt` is an ISO-8601 instant. Always appends a fresh row — re-granting after a revoke mints a new receipt.",
});

webConsentGrantBody.meta({
  id: "WebConsentGrantBody",
  description:
    'Optional. Omitting the body (or sending `intent: "heal"`) is the AI-settings mount heal: it mints only for an account with no `ai_full` consent history at all, so a standing revocation is never resurrected. `intent: "affirmative"` is the user\'s own grant action and may supersede an earlier revocation, exactly as a first grant would.',
});

const consentReceiptResponse = z
  .object({
    id: z.string(),
    receipt: z.object({
      id: z.string(),
      userId: z.string(),
      kind: consentKindEnum,
      signedAt: z.string(),
      revokedAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  })
  .meta({
    id: "ConsentReceiptResponse",
    description:
      "The minted receipt. `artefact` is deliberately stripped from the response — it is opaque and only read at audit time directly from the DB.",
  });

const webConsentGrantResponse = z
  .object({
    minted: z
      .boolean()
      .describe(
        "True when a new `ai_full` receipt was minted; false when an active one already existed (idempotent no-op).",
      ),
    kind: z.literal("ai_full"),
  })
  .meta({
    id: "WebConsentGrantResponse",
    description:
      "Outcome of the idempotent web `ai_full` grant. Safe to call on every AI-settings mount.",
  });

export const consentPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/consent/ai": {
    post: {
      tags: ["Consent"],
      summary: "Grant AI consent (signed artefact)",
      description:
        "Persist a fresh AI-consent receipt. Required before server-managed AI egress (the operator's global LLM key); BYOK / local / ChatGPT-OAuth chains are the user's own egress and are not gated. Append-only audit trail.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: consentPostBody },
        },
      },
      responses: {
        "200": {
          description: "The minted receipt.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                consentReceiptResponse,
                "ConsentReceiptResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        "400": {
          description: "Request validation failed (consent routes use 400).",
          content: {
            "application/json": {
              schema: dataEnvelope(z.null(), "ConsentValidationErrorEnvelope"),
            },
          },
        },
      },
    },
  },
  "/api/consent/ai/web": {
    post: {
      tags: ["Consent"],
      summary: "Grant web AI consent (idempotent ai_full)",
      description:
        'Mint an `ai_full` consent receipt for the calling web user if none is active; a no-op when one already exists. Mirrors the iOS master grant. Without a body (the mount heal) it grants only to an account with no consent history, so a revocation stands until the user grants again; with `intent: "affirmative"` (the explicit grant control) it records the user\'s own consent act, which may supersede an earlier revocation. Revocation flows through DELETE /api/consent/ai/latest.',
      requestBody: {
        required: false,
        content: {
          "application/json": { schema: webConsentGrantBody },
        },
      },
      responses: {
        "200": {
          description: "Grant outcome.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webConsentGrantResponse,
                "WebConsentGrantResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
