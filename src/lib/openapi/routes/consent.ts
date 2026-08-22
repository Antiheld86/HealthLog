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
  consentPostBody as consentPostBodyBase,
  webConsentGrantBody as webConsentGrantBodyBase,
} from "@/lib/validations/consent";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// `.meta()` CLONES in Zod 4 rather than annotating in place, so the returned
// schema has to be captured and referenced. A bare `schema.meta({...})`
// statement registers nothing and the component id it names never reaches the
// emitted document. The imports are aliased so the annotated clone can keep the
// name every use site below already spells.
const consentPostBody = consentPostBodyBase.meta({
  id: "ConsentPostBody",
  description:
    "Explicit AI-consent grant. `artefact` is an opaque signed receipt (base64 PDF or JWT, ≤ 64 KB UTF-8 bytes); `signedAt` is an ISO-8601 instant. Always appends a fresh row — re-granting after a revoke mints a new receipt.",
});

const webConsentGrantBody = webConsentGrantBodyBase.meta({
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

const serialisedReceipt = z
  .object({
    id: z.string(),
    userId: z.string(),
    kind: consentKindEnum,
    signedAt: z.iso.datetime({ offset: true }),
    revokedAt: z.iso.datetime({ offset: true }).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SerialisedConsentReceipt",
    description:
      "A consent receipt as the API returns it. `artefact` is stripped — it is opaque, large, and only read at audit time straight from the database.",
  });

const consentLatestOneKind = z
  .object({
    kind: consentKindEnum,
    receipt: serialisedReceipt
      .nullable()
      .describe("Null when no active receipt of that kind exists."),
  })
  .meta({ id: "ConsentLatestForKind" });

const consentLatestAllKinds = z
  .object({
    ai_full: serialisedReceipt.nullable(),
    ai_insights_only: serialisedReceipt.nullable(),
    ai_coach: serialisedReceipt.nullable(),
  })
  .meta({
    id: "ConsentLatestByKind",
    description:
      "The latest active receipt for every kind. All three keys are always present: a null value means the kind is not granted, so a client never has to read absence as ambiguity.",
  });

const consentRevokeAllKinds = z
  .object({
    revoked: z
      .array(z.object({ kind: consentKindEnum, receipt: serialisedReceipt }))
      .describe(
        "One entry per kind that HAD an active receipt. A kind already revoked contributes nothing, so an empty array means there was nothing left to revoke.",
      ),
  })
  .meta({ id: "ConsentRevokeAllResponse" });

/**
 * The 400 the two `/latest` verbs answer for a bad `kind`.
 *
 * Spread AFTER `...stdResponses`: the consent family validates to 400 rather
 * than the 422 the rest of the API uses, and the generic entry would otherwise
 * leave the reader looking for a status this route never sends.
 */
const consentQueryValidation400 = {
  "400": {
    description:
      "`kind` was present but is not one of `ai_full`, `ai_insights_only`, `ai_coach`. Multi-issue envelope; nothing was read or revoked. The consent family answers 400 here where the rest of the API answers 422.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

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
  // ── Appended: the latest-receipt reader and the revoke, both long shipped
  // and neither ever registered.
  "/api/consent/ai/latest": {
    get: {
      tags: ["Consent"],
      summary: "Read the latest active consent receipt(s)",
      description:
        "The response SHAPE depends on the query, which is the one thing a client has to get right here. With `?kind=` it is `{ kind, receipt }` for that kind alone; WITHOUT it, a map keyed by all three kinds. There is no shape that covers both — decode on whether you sent the parameter.\n" +
        "\n" +
        "Only non-revoked receipts are considered: a revoked one is never returned, and the reader does not distinguish “revoked” from “never granted”. Auth via cookie or a wildcard Bearer token; rate-limited on the shared per-user consent bucket.",
      requestParams: {
        query: z.object({
          kind: consentKindEnum
            .optional()
            .describe(
              "Narrow to one consent kind. Omit for the full keyspace.",
            ),
        }),
      },
      responses: {
        "200": {
          description:
            "The receipt for the requested kind, or the map across all three when `kind` was omitted.",
          content: {
            "application/json": {
              schema: z.union([
                dataEnvelope(
                  consentLatestOneKind,
                  "ConsentLatestForKindEnvelope",
                ),
                dataEnvelope(
                  consentLatestAllKinds,
                  "ConsentLatestByKindEnvelope",
                ),
              ]),
            },
          },
        },
        ...stdResponses,
        ...consentQueryValidation400,
      },
    },
    delete: {
      tags: ["Consent"],
      summary: "Revoke the latest consent receipt, or all of them",
      description:
        "With `?kind=` it revokes the latest active receipt of that kind; WITHOUT it, it revokes the latest active receipt of EVERY kind — the master “turn AI off” switch. As with the GET, the two arms answer different shapes.\n" +
        "\n" +
        "Idempotent on purpose, and it is worth knowing why: revoking a kind that has nothing active answers 200 with `receipt: null` rather than 404, because the client toggle fires this on every flip and a 404 would render as a failure the user cannot act on. Revocation is append-only in effect — the row is stamped, never deleted — and each revocation is audit-logged.\n" +
        "\n" +
        "Revoking `ai_full` does NOT switch off `documentsAutoAiRead`; that flag is written through PATCH /api/auth/me/documents-auto-ai-read and turning it on mints a fresh receipt. A client offering both controls should show them as the two separate things they are.",
      requestParams: {
        query: z.object({
          kind: consentKindEnum
            .optional()
            .describe(
              "Revoke one kind. Omit to revoke the latest active receipt across every kind.",
            ),
        }),
      },
      responses: {
        "200": {
          description:
            "The revoked receipt for the named kind (or `receipt: null` when there was none), or the list of everything revoked when `kind` was omitted.",
          content: {
            "application/json": {
              schema: z.union([
                dataEnvelope(
                  consentLatestOneKind,
                  "ConsentRevokeForKindEnvelope",
                ),
                dataEnvelope(consentRevokeAllKinds, "ConsentRevokeAllEnvelope"),
              ]),
            },
          },
        },
        ...stdResponses,
        ...consentQueryValidation400,
      },
    },
  },
};
