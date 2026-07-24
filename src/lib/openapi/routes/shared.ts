/**
 * Shared OpenAPI building blocks — response envelopes and standard error responses used across every route module.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import {
  createMeasurementSchema,
  listMeasurementsSchema,
  measurementTypeEnum,
  measurementSourceEnum,
} from "@/lib/validations/measurement";
import { loginPasswordSchema } from "@/lib/validations/auth";
import { coachPrefsSchema } from "@/lib/validations/coach-prefs";
import { createBatchWorkoutSchema } from "@/lib/validations/workout";

/**
 * Common envelopes — every HealthLog API response wraps payload in
 * `{ data, error, meta? }`. The OpenAPI surface mirrors that contract
 * so iOS / external-ingest clients can decode uniformly.
 */
export const errorEnvelope = z
  .object({
    data: z.null(),
    error: z.string(),
    meta: z
      .object({
        requestId: z.string().optional(),
        errorCode: z.string().optional(),
      })
      .optional(),
  })
  .meta({
    id: "ErrorEnvelope",
    description: "Standard error response: data is null, error is human prose.",
  });

export function dataEnvelope<T extends z.ZodType>(payload: T, id: string) {
  return z
    .object({
      data: payload,
      error: z.null(),
      meta: z.object({ requestId: z.string().optional() }).optional(),
    })
    .meta({ id });
}

// ── Schemas — annotated for spec emission ────────────────────────────

measurementTypeEnum.meta({
  id: "MeasurementType",
  description:
    "DB-stored measurement category. v1.4.23 added 7 Apple Health values (HRV, resting HR, active energy, flights, walking/running distance, VO2 max, body temperature).",
});

measurementSourceEnum.meta({
  id: "MeasurementSource",
  description:
    "Origin of the measurement. v1.4.23 added APPLE_HEALTH for the iOS HealthKit batch ingest path.",
});

loginPasswordSchema.meta({
  id: "LoginPasswordRequest",
  description:
    "Email-or-username login. The native-client flow returns a paired access + refresh token when X-Client-Type: native or the iOS UA prefix is present.",
});

createMeasurementSchema.meta({
  id: "CreateMeasurementRequest",
  description:
    "Single-measurement ingest body. Plausibility-range guard runs server-side; out-of-range values fail 422.",
});

listMeasurementsSchema.meta({
  id: "ListMeasurementsQuery",
  description:
    "Query params for the measurements list endpoint. `limit` capped at 500.",
});

coachPrefsSchema.meta({
  id: "CoachPrefs",
  description:
    "Per-user Coach prompt-tuning preferences (v1.4.23 H4). All fields default to the legacy v1.4.22 behaviour when omitted.",
});

createBatchWorkoutSchema.meta({
  id: "CreateBatchWorkoutRequest",
  description:
    "Typed workout batch ingest. Each entry is an HKWorkout-aligned record with an optional nested GeoJSON LineString route AND an optional route-independent per-workout heart-rate series (`samples`: `[{ t, hr?, speedMs?, power?, cadence? }]`, up to 30 000 points). The `samples` series is the strain-engine input for indoor workouts that have no GPS route. Up to 100 workouts per call; nested route geometry capped at 20 000 points. Withings server-to-server callers pass source: WITHINGS and ship no route (Withings reports aggregates only).",
});

// ── Optimistic concurrency (v1.32.21 / R5a) ──────────────────────────
// The write endpoints that read-modify-write a per-user blob accept an
// optional `baseUpdatedAt` base token (the `updatedAt` the client last
// read) and guard the write on the stored row still carrying it. A stale
// token fails the write with 409 and changes nothing; an omitted token
// takes the prior unconditional write (backward-compatible). The token is
// OPAQUE — clients only ever echo a server-returned value.

/**
 * Optional request field carrying the optimistic-concurrency base token.
 * Extend a request schema with `{ baseUpdatedAt: baseUpdatedAtField }` at the
 * OpenAPI layer: the runtime strips it pre-Zod (`takeBaseToken`), so the
 * runtime schema alone would under-document the wire.
 */
export const baseUpdatedAtField = z.iso
  .datetime({ offset: true })
  .optional()
  .describe(
    "Optimistic-concurrency base token: the `updatedAt` the client last read for this resource. Omit it for the legacy unconditional write (older clients are unaffected). When present, the write is guarded on the stored row still carrying this exact value — a stale token fails with 409 and changes nothing. Treat as opaque: only ever echo a server-returned value, never parse or synthesise it.",
  );

/**
 * Optional response field echoing the fresh optimistic-concurrency token.
 * Every guarded GET / write response carries the stored row's `updatedAt`; the
 * client echoes it back as `baseUpdatedAt` on the next write.
 */
export const updatedAtTokenField = z.iso
  .datetime({ offset: true })
  .optional()
  .describe(
    "Optimistic-concurrency token: the stored row's `updatedAt` at read/write time. Echo it back as `baseUpdatedAt` on the next write. Opaque — only ever echo a server-returned value, never parse or synthesise it.",
  );

/**
 * The 409 the guarded write returns when the base token is stale. `errorCode`
 * is per-endpoint; the caller passes the resource noun + the concrete
 * errorCode so the prose enumerates it.
 */
export function conflictResponse409(resource: string, errorCode: string) {
  return {
    "409": {
      description: `${resource} changed since it was loaded (optimistic-concurrency conflict). No write happened. Re-read the resource, re-apply the user's change against the fresh state, and resend with the new token. \`meta.errorCode\` = \`${errorCode}\`.`,
      content: { "application/json": { schema: errorEnvelope } },
    },
  };
}

// ── Standard 401 / 422 / 429 responses ───────────────────────────────

export const stdResponses = {
  "401": {
    description: "Authentication required or invalid credentials.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "422": {
    description: "Request validation failed.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "429": {
    description: "Rate limit exceeded.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

// ── AI-consent precondition (v1.16.13) ───────────────────────────────
// The server-managed AI-egress gate requires an active ConsentReceipt
// (`ai_full`, or the surface-specific `ai_insights_only` / `ai_coach`)
// before any health snapshot leaves for the operator's global LLM key.
// Interactive routes surface this as a 403 with
// `meta.errorCode = "consent.ai.required"`; clients render an inline
// grant-consent notice and call POST /api/consent/ai (or, on web, POST
// /api/consent/ai/web) to mint the receipt. BYOK / local / ChatGPT-OAuth
// chains are the user's own egress and never trip this gate.
export const consentRequiredResponse = {
  "403": {
    description:
      "AI consent required: no active ConsentReceipt for the server-managed provider. `meta.errorCode` = `consent.ai.required`. Mint a receipt via POST /api/consent/ai before retrying.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

// ── Module-disabled gate (v1.18.0) ───────────────────────────────────
// Every module-scoped route runs `requireModuleEnabled(userId, key)`,
// which returns a 403 when the account has the module turned off — even
// with a valid Bearer token. The envelope carries
// `meta.errorCode = "module.disabled"` and `meta.module` (the disabled
// module key) so the iOS retry classifier branches on it and the client
// can drop the whole surface. The errorEnvelope shape already declares
// `meta.errorCode`; `meta.module` is documented here in prose.
export const moduleDisabledResponse = {
  "403": {
    description:
      'Module disabled for this account: the user (or operator) has the module turned off. `meta.errorCode` = `module.disabled` and `meta.module` carries the disabled module key (e.g. "sleep"). Returned even for a valid Bearer token. Clients hide the whole module surface end-to-end rather than retry.',
    content: { "application/json": { schema: errorEnvelope } },
  },
};
