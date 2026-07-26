/**
 * OpenAPI route table — account profile, avatar, coach prefs, disable-coach, source priority.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { coachPrefsSchema } from "@/lib/validations/coach-prefs";
import { notificationPrefsSchema } from "@/lib/validations/notification-prefs";
import { sourcePrioritySchema } from "@/lib/validations/source-priority";
import { modulePrefsPatchSchema } from "@/lib/validations/modules";
import { MODULE_KEYS } from "@/lib/modules/registry";
import {
  dataEnvelope,
  errorEnvelope,
  stdResponses,
  baseUpdatedAtField,
  updatedAtTokenField,
  conflictResponse409,
} from "./shared";

// v1.18.0 — module enable/disable. The PATCH request is the REAL runtime
// validator (`modulePrefsPatchSchema` — strict over the toggleable key
// set; a core-domain or unknown key is a 422). The response is the
// fully-resolved `{ <moduleKey>: boolean }` map for every toggleable
// module: `cycle` mirrors the cycle gate, `coach` mirrors the resolved
// `disableCoach` + operator master flag, the rest read the per-user
// disabled-allowlist. The map is the single thing a client needs to gate
// every secondary domain end-to-end.
// v1.32.22 (M3) — the doc request extends the strict runtime schema with the
// optimistic-concurrency `baseUpdatedAt` token. The runtime strips it pre-Zod
// (`takeBaseToken`) BEFORE the strict parse, so the runtime schema alone would
// under-document the wire; documenting it here keeps the contract complete.
const modulePrefsPatchRequest = modulePrefsPatchSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "ModulePrefsPatchRequest",
    description:
      'Partial module enable/disable update. Each key is an optional boolean; an omitted key is left untouched, `false` disables the module, `true` (re-)enables it. Only the toggleable "secondary domains" are accepted — a core-domain key (`weight`, `bloodPressure`, `pulse`, `medications`) or any unknown key is a 422, so the measurement engine + medications can never be disabled here. `cycle`/`coach` are accepted for forward-compat but their real enabled-state is owned elsewhere (the cycle gate / `disableCoach` + the operator assistant flag). `baseUpdatedAt` is the optional optimistic-concurrency token — omit it for the legacy unconditional write.',
  });

const moduleMapResolved = z
  .object(
    Object.fromEntries(
      MODULE_KEYS.map((k) => [
        k,
        z
          .boolean()
          .describe(`Whether the "${k}" module is enabled for this account.`),
      ]),
    ),
  )
  .meta({
    id: "ModuleMap",
    description:
      "Fully-resolved per-user module enable/disable map. Every toggleable module key is present. `false` means the surface should disappear end-to-end (nav, dashboard, insights, …). `cycle` mirrors `cycleTrackingEnabled`; `coach` mirrors the resolved per-user opt-out + operator master flag.",
  });

const moduleMapEnvelopeInner = z
  .object({ modules: moduleMapResolved, updatedAt: updatedAtTokenField })
  .meta({ id: "ModulesResponse" });

// v1.4.49 — single schema for the per-user Coach opt-out flag. Previously
// split into `disableCoachBody` (PATCH request) and `disableCoachData`
// (response payload), both `z.object({ disableCoach: z.boolean() })`. The
// payload was passed through `dataEnvelope(..., "GetDisableCoachResponse")`
// / `dataEnvelope(..., "PatchDisableCoachResponse")` which IDs the
// envelope wrapper — the inner flag carries its own `.meta()` and now
// renders as a single `$ref: "#/components/schemas/DisableCoachFlag"` in
// both the request body and both response envelopes.
const disableCoachFlag = z
  .object({
    disableCoach: z.boolean(),
  })
  .meta({
    id: "DisableCoachFlag",
    description:
      "Per-account Coach opt-out toggle (v1.4.47 W3). `true` hides the Coach FAB and short-circuits its API gates.",
  });

// v1.18.6 — explicit diabetes opt-in. Shared by GET (current) and PATCH
// (request body + resolved response). `true` switches the glucose target
// resolver to the tighter ADA glycemic GOAL bands (fasting 80–130,
// postprandial < 180). Never inferred from a reading; asserts no diagnosis.
const diabetesFlag = z
  .object({
    hasDiabetes: z.boolean(),
  })
  .meta({
    id: "DiabetesFlag",
    description:
      "Per-account diabetes opt-in (v1.18.6). `true` selects the ADA glycemic GOAL bands (fasting 80–130, postprandial < 180) for glucose targets instead of the general non-diabetic bands. A user-declared preference only — never inferred from a value, never a diagnosis.",
  });

// v1.16.11 — per-user notification preferences. The PATCH request body
// is the REAL runtime validator (`notificationPrefsSchema` — every
// category and field optional, deep-merged server-side); the response
// is the fully-resolved shape with the documented defaults filled in.
// v1.32.22 (M1) — the doc request extends the runtime validator with the
// optimistic-concurrency `baseUpdatedAt` token (stripped pre-Zod at runtime).
const notificationPrefsPatchRequest = notificationPrefsSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "NotificationPrefsPatchRequest",
    description:
      "Partial per-user notification preferences. Every category and field is optional; the server deep-merges the supplied keys over the persisted row, so a PATCH touching only `medication` leaves the siblings intact. `medication.lowStockRunwayDays` (1–60, nullable) is the low-stock alert threshold in remaining runway days — `null` switches the alert off. `baseUpdatedAt` is the optional optimistic-concurrency token: echo it to have the server refuse (409) a write that would silently revert a category another writer set from a fresher read (e.g. iOS `medication.clientManaged`). Omit it for the legacy unconditional write.",
  });

const notificationPrefsResolved = z
  .object({
    medication: z.object({
      clientManaged: z
        .boolean()
        .describe(
          "True when the iOS app owns local medication reminders; the server-side MEDICATION_REMINDER APNs cron is suppressed.",
        ),
      deliveryDefault: z
        .enum(["server", "client"])
        .describe(
          'Roaming user-level delivery default. "client" implies clientManaged: true.',
        ),
      lowStockRunwayDays: z
        .number()
        .int()
        .min(1)
        .max(60)
        .nullable()
        .describe(
          "Low-stock alert threshold as remaining runway days (1–60). null = alert off. Default 7.",
        ),
      reorderLeadDays: z
        .number()
        .int()
        .min(0)
        .max(60)
        .describe(
          "Reorder lead time in days (0–60) the low-stock alert assumes. The alert fires this lead plus one dose-interval before the supply runs out so a refill arrives before the last dose. Default 10; a per-medication reorderLeadDays overrides it.",
        ),
    }),
    mood: z.object({
      reminderHour: z
        .number()
        .int()
        .min(0)
        .max(23)
        .describe("Local-time hour for the daily mood reminder. Default 22."),
    }),
    cycle: z.object({
      clientManaged: z
        .boolean()
        .describe(
          "True when the iOS app owns local cycle reminders; the server-side cycle APNs cron is suppressed.",
        ),
    }),
    coach: z.object({
      nudgesEnabled: z
        .boolean()
        .describe("Master switch for the proactive Coach nudge cron."),
      nudgeMedication: z
        .boolean()
        .describe("Medication-group nudge triggers (compliance)."),
      nudgeVitals: z
        .boolean()
        .describe("Vitals-group nudge triggers (bp / score / weight / sleep)."),
      nudgeRoutine: z
        .boolean()
        .describe(
          "Routine-group nudge triggers (measurement gap / self-context).",
        ),
      nudgeFrequency: z
        .enum(["weekly", "biweekly"])
        .describe("Nudge frequency cap: one per 7 or per 14 days."),
    }),
  })
  .meta({
    id: "NotificationPrefs",
    description:
      "Fully-resolved per-user notification preferences. Every key is present — a null / drifted persisted row resolves to the documented defaults.",
  });

// v1.32.22 (M1) — GET / PATCH responses carry the optimistic-concurrency token
// as an additive sibling key next to the resolved categories.
const notificationPrefsResponse = notificationPrefsResolved
  .extend({ updatedAt: updatedAtTokenField })
  .meta({ id: "NotificationPrefsResponse" });

// v1.32.22 (M4) — coach-prefs GET / PUT responses carry the token; the PUT
// request extends the runtime validator with the base token.
const coachPrefsResponse = coachPrefsSchema
  .extend({ updatedAt: updatedAtTokenField })
  .meta({ id: "CoachPrefsResponse" });
const coachPrefsPutRequest = coachPrefsSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "PutCoachPrefsRequest",
    description:
      "Coach prompt-tuning preferences to persist, plus the optional optimistic-concurrency `baseUpdatedAt` token. The guarded write covers both `coachPrefsJson` and the mirrored `insightsExcludeMetrics` column atomically. Omit the token for the legacy unconditional write.",
  });

// v1.8.6 — profile read/write surface for the native client. The
// runtime validation lives in `src/lib/validations/auth.ts`
// (`profileSchema`, whose transforms normalise empty → null and run the
// KVNR/IKNR refines); the OpenAPI shapes below mirror the wire contract
// without those transforms so the spec stays a clean nullable-field
// document. `insurerIkNumber` is the new v1.8.6 field: optional, 9-digit
// German IKNR, surfaced on the FHIR `Coverage` payor.
const profileUpdateRequest = z
  .object({
    email: z.email().nullable().optional(),
    heightCm: z.number().min(50).max(300).nullable().optional(),
    dateOfBirth: z.string().nullable().optional(),
    gender: z
      .enum(["MALE", "FEMALE", "OTHER"])
      .nullable()
      .optional()
      .describe(
        "Stored gender. Null or an empty string clears it; an omitted field is left untouched.",
      ),
    displayName: z.string().min(1).max(80).nullable().optional(),
    locale: z.enum(["de", "en"]).nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    timeFormat: z
      .enum(["AUTO", "H12", "H24"])
      .optional()
      .describe(
        "Hour-cycle display preference. AUTO follows the locale convention, H12 forces AM/PM, H24 forces 24-hour.",
      ),
    dateFormat: z
      .enum(["AUTO", "DMY", "MDY", "YMD"])
      .optional()
      .describe(
        "Date-order display preference. AUTO follows the locale convention, DMY pins day-month-year (dd.MM.yyyy), MDY pins month-day-year (MM/dd/yyyy), YMD pins ISO yyyy-MM-dd.",
      ),
    moodReminderEnabled: z.boolean().optional(),
    fullName: z.string().max(120).nullable().optional(),
    insurerName: z.string().max(120).nullable().optional(),
    insuranceNumber: z
      .string()
      .nullable()
      .optional()
      .describe("German KVNR. Empty/null clears it; mod-10 check enforced."),
    insurerIkNumber: z
      .string()
      .nullable()
      .optional()
      .describe(
        "German insurer institution number (IKNR). Optional; empty/null clears it. A non-empty value must be exactly 9 digits (no checksum enforced).",
      ),
  })
  .meta({
    id: "ProfileUpdateRequest",
    description:
      "Partial profile update. Every field is optional and an omitted field is left untouched. An explicit null clears any nullable field; an empty string also clears `displayName`, `dateOfBirth`, `gender`, `fullName`, `insurerName`, `insuranceNumber` and `insurerIkNumber`. `email` is not among them — it is validated as an address, so send null to clear it. `locale`, `timezone`, `timeFormat` and `dateFormat` are not clearable. `userId` is never accepted — it is narrowed from the session/token.",
  });

const profileResponse = z
  .object({
    username: z.string(),
    displayName: z.string().nullable().optional(),
    email: z.string().nullable(),
    dateOfBirth: z.iso.datetime({ offset: true }).nullable(),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable(),
    heightCm: z.number().nullable(),
    locale: z.string().nullable(),
    timezone: z.string(),
    timeFormat: z
      .enum(["AUTO", "H12", "H24"])
      .describe(
        "Hour-cycle display preference. AUTO follows the locale convention, H12 forces AM/PM, H24 forces 24-hour.",
      ),
    dateFormat: z
      .enum(["AUTO", "DMY", "MDY", "YMD"])
      .describe(
        "Date-order display preference. AUTO follows the locale convention, DMY pins day-month-year (dd.MM.yyyy), MDY pins month-day-year (MM/dd/yyyy), YMD pins ISO yyyy-MM-dd.",
      ),
    moodReminderEnabled: z.boolean(),
    fullName: z.string().nullable(),
    insurerName: z.string().nullable(),
    insurerIkNumber: z
      .string()
      .nullable()
      .describe("German insurer institution number (IKNR), 9 digits."),
    insuranceNumber: z
      .string()
      .nullable()
      .describe("German KVNR, decrypted for the form prefill."),
    // v1.18.0 — resolved module enable/disable map, identical to the
    // /api/auth/me projection. The native client reads this alias, so it
    // must carry the same server-authoritative module flags.
    modules: moduleMapResolved,
  })
  .meta({
    id: "ProfileResponse",
    description:
      "Flattened profile fields for the native client (GET). The KVNR is decrypted server-side; the IKNR (v1.8.6) is plaintext at rest. The `modules` map mirrors the /api/auth/me projection so the alias carries the same module flags.",
  });

// The PATCH echo mirrors GET but reports KVNR presence as a boolean
// (`hasInsuranceNumber`) rather than re-emitting the decrypted value.
const profileUpdateResponse = z
  .object({
    username: z.string(),
    displayName: z.string().nullable().optional(),
    email: z.string().nullable(),
    dateOfBirth: z.iso.datetime({ offset: true }).nullable(),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable(),
    heightCm: z.number().nullable(),
    locale: z.string().nullable(),
    timezone: z.string(),
    timeFormat: z
      .enum(["AUTO", "H12", "H24"])
      .describe(
        "Hour-cycle display preference. AUTO follows the locale convention, H12 forces AM/PM, H24 forces 24-hour.",
      ),
    dateFormat: z
      .enum(["AUTO", "DMY", "MDY", "YMD"])
      .describe(
        "Date-order display preference. AUTO follows the locale convention, DMY pins day-month-year (dd.MM.yyyy), MDY pins month-day-year (MM/dd/yyyy), YMD pins ISO yyyy-MM-dd.",
      ),
    moodReminderEnabled: z.boolean(),
    fullName: z.string().nullable(),
    insurerName: z.string().nullable(),
    insurerIkNumber: z
      .string()
      .nullable()
      .describe("German insurer institution number (IKNR), 9 digits."),
    hasInsuranceNumber: z
      .boolean()
      .describe("Whether a KVNR is on file (the value itself is not echoed)."),
  })
  .meta({
    id: "ProfileUpdateResponse",
    description:
      "Profile echo returned by the PATCH/PUT update path. Reports KVNR presence as a boolean rather than re-emitting the decrypted value.",
  });

// v1.16.16 — AI-provider read surface. iOS gates Coach visibility off
// `aiAvailable` + `managedBy` so a server-managed (operator-key) provider
// is no longer invisible to the client. The response reports key PRESENCE
// + a 4-char masked preview only; no plaintext key or admin endpoint is
// ever surfaced. `managedBy` reports the resolved provider origin: `user`
// (BYOK), `local` (self-hosted Ollama/LM Studio), `server` (operator's
// shared key), or null when no provider can serve the caller.
const aiProviderResponse = z
  .object({
    provider: z
      .enum(["OPENAI", "ANTHROPIC", "LOCAL", "CHATGPT_OAUTH"])
      .nullable()
      .describe("The user's selected provider, or null when none is set."),
    model: z.string().nullable(),
    baseUrl: z
      .string()
      .nullable()
      .describe("Custom base URL (LOCAL provider only); null otherwise."),
    aiAvailable: z
      .boolean()
      .describe(
        "True when ANY provider can serve this user — including the operator's server-managed key when the user set none. iOS keys Coach visibility off this.",
      ),
    managedBy: z
      .enum(["user", "local", "server"])
      .nullable()
      .describe(
        "Resolved provider origin: `user` (BYOK), `local` (self-hosted), `server` (operator key), or null when no provider is available.",
      ),
    hasAnthropicKey: z.boolean(),
    anthropicKeyPreview: z
      .string()
      .nullable()
      .describe("`...` + last 4 chars of the stored Anthropic key, or null."),
    hasLocalKey: z.boolean(),
    hasOpenaiKey: z.boolean(),
    openaiKeyPreview: z
      .string()
      .nullable()
      .describe("`...` + last 4 chars of the stored OpenAI key, or null."),
    responseTimeoutSeconds: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.22 (#89) — per-user response timeout for AI generation, in seconds (10–600). Null = the built-in comprehensive-briefing default (~120 s). Mainly for slow local/self-hosted backends.",
      ),
  })
  .meta({
    id: "AiProviderResponse",
    description:
      "The calling user's AI-provider configuration plus the effective availability (`aiAvailable` + `managedBy`). Reports key presence + a masked preview only — never a plaintext key.",
  });

export const profilePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/user/ai-provider": {
    get: {
      tags: ["Auth"],
      summary: "Read the calling user's AI-provider configuration",
      description:
        "Returns the user's selected provider/model/baseUrl plus the effective availability: `aiAvailable` is true when any provider can serve the user (BYOK, self-hosted, or the operator's server-managed key), and `managedBy` reports which. iOS gates Coach visibility off these two fields. Key material is reported as presence + a 4-char masked preview only.",
      responses: {
        "200": {
          description: "Resolved AI-provider configuration.",
          content: {
            "application/json": {
              schema: dataEnvelope(aiProviderResponse, "GetAiProviderResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/coach-prefs": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user Coach prompt-tuning preferences",
      description:
        "Returns the persisted preferences with defaults filled in. Null persisted state resolves to the legacy v1.4.22 defaults.",
      responses: {
        "200": {
          description: "Resolved preferences plus the `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsResponse, "GetCoachPrefsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace per-user Coach prompt-tuning preferences",
      description:
        "Persists the supplied prefs. Body is validated against `CoachPrefs`; missing keys fall back to the documented defaults. Supports optimistic concurrency: echo the `updatedAt` from the last read as `baseUpdatedAt` and the write is refused with 409 if the row changed since; omit it for the legacy unconditional write.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: coachPrefsPutRequest } },
      },
      responses: {
        "200": {
          description: "Saved preferences echoed back with the fresh token.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsResponse, "PutCoachPrefsResponse"),
            },
          },
        },
        ...conflictResponse409("Coach preferences", "coach_prefs_conflict"),
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/disable-coach": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user Coach opt-out flag",
      description:
        'Returns the user\'s per-account Coach opt-out flag. Default `false` (Coach visible). Powers the Settings → Insights "Hide Coach" Switch and the layout FAB short-circuit.',
      responses: {
        "200": {
          description: "Resolved flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(disableCoachFlag, "GetDisableCoachResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Toggle per-user Coach opt-out flag",
      description:
        "Flips the per-account Coach opt-out flag. Idempotent — the DB write fires even when the value matches so the audit-log row mirrors the API call. Rate-limit 60/min per user.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: disableCoachFlag } },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state echoed back for optimistic-update consumers.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                disableCoachFlag,
                "PatchDisableCoachResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/diabetes": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user diabetes opt-in flag",
      description:
        'Returns the user\'s per-account diabetes opt-in flag. Default `false`. When `true`, the glucose target resolver applies the tighter ADA glycemic GOAL bands (fasting 80–130, postprandial < 180) instead of the general non-diabetic bands. Powers the Settings "I have diabetes / clinician glucose targets" toggle. Never inferred from a reading; asserts no diagnosis.',
      responses: {
        "200": {
          description: "Resolved flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(diabetesFlag, "GetDiabetesResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Toggle per-user diabetes opt-in flag",
      description:
        "Sets the per-account diabetes opt-in flag. Idempotent — the DB write fires even when the value matches so the audit-log row mirrors the API call. Always returns the resolved next-state. `userId` is never accepted from the body. Rate-limit 60/min per user.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: diabetesFlag } },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state echoed back for optimistic-update consumers.",
          content: {
            "application/json": {
              schema: dataEnvelope(diabetesFlag, "PatchDiabetesResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/modules": {
    get: {
      tags: ["Auth"],
      summary: "Read the resolved per-user module enable/disable map",
      description:
        "Returns the fully-resolved `{ <moduleKey>: boolean }` map for every toggleable module. `cycle` reflects the cycle gate, `coach` reflects the resolved per-user opt-out + operator master flag, and the rest read the per-user disabled-allowlist (`modulePreferencesJson`). Default-on: a fresh account reads every module enabled. iOS/web read this to hide a whole module surface end-to-end.",
      responses: {
        "200": {
          description: "Resolved module map.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moduleMapEnvelopeInner,
                "GetModulesResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Update per-user module enable/disable preferences",
      description:
        "Merges the supplied keys into the persisted disabled-allowlist (`modulePreferencesJson`) field-by-field — a PATCH touching only one module leaves the siblings intact. Refuses to disable a core module (`weight`, `bloodPressure`, `pulse`, `medications`) or any unknown key with a 422. `userId` is never accepted from the body. Always returns the fully-resolved next-state map so clients can hard-set their optimistic update. Rate-limit 60/min per user.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: modulePrefsPatchRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state module map echoed back with the fresh `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moduleMapEnvelopeInner,
                "PatchModulesResponse",
              ),
            },
          },
        },
        ...conflictResponse409("Module preferences", "modules_conflict"),
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/source-priority": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user source priority",
      description:
        "Returns the per-metric-class source priority used by the analytics aggregator. Missing keys fall back to `DEFAULT_SOURCE_PRIORITY`. Null persisted state resolves to the documented defaults.",
      responses: {
        "200": {
          description: "Resolved priority.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                sourcePrioritySchema,
                "GetSourcePriorityResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace per-user source priority",
      description:
        "Persists the supplied priority. Body is validated against `SourcePriority`; missing keys read as `DEFAULT_SOURCE_PRIORITY` at the call site.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: sourcePrioritySchema } },
      },
      responses: {
        "200": {
          description: "Saved priority (defaulted) echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                sourcePrioritySchema,
                "PutSourcePriorityResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/avatar": {
    post: {
      tags: ["Auth"],
      summary: "Upload the calling user's avatar",
      description:
        "Multipart upload (field `file`). Accepts image/jpeg, image/png, image/webp; rejects anything else at the magic-byte sniff (the multipart Content-Type header is informational only). Hard caps: 2 MiB body, 2048×2048 dimensions. Replaces the v1.4.22 Gravatar leak by storing the bytes on the User row + serving them from same-origin.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z
                .string()
                .describe(
                  "Binary image payload (JPEG / PNG / WebP). Hard-capped at 2 MiB and 2048×2048.",
                ),
            }),
          },
        },
      },
      responses: {
        "201": {
          description:
            "Avatar saved. `avatarUrl` is the same value the /me payload returns; the `?v=` suffix busts client caches on re-upload.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  avatarUrl: z.string(),
                  contentType: z.enum([
                    "image/jpeg",
                    "image/png",
                    "image/webp",
                  ]),
                  updatedAt: z.iso.datetime({ offset: true }),
                }),
                "UploadAvatarResponse",
              ),
            },
          },
        },
        "413": {
          description:
            "Upload exceeds the 2 MiB byte limit or the 2048×2048 dimension limit.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description:
            "Image format is not one of JPEG / PNG / WebP (magic-byte sniff).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Clear the calling user's avatar",
      description:
        "Resets the avatar columns to null. Idempotent — a delete on an already-empty row returns 204 with no audit-log row.",
      responses: {
        "204": {
          description: "Avatar cleared (or already empty).",
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/avatar/{id}": {
    get: {
      tags: ["Auth"],
      summary: "Serve a user's avatar bytes",
      description:
        "Owner-scoped. The `{id}` path segment must match the calling user's id — cross-user reads return 403. Response body is the raw image bytes with the persisted `Content-Type`; the /me payload appends `?v={updatedAtMs}` so clients can cache aggressively.",
      requestParams: {
        path: z.object({
          id: z.string().describe("User id (must match the calling user)."),
        }),
      },
      responses: {
        "200": {
          description: "Avatar bytes.",
          content: {
            "image/jpeg": { schema: z.string().describe("Raw JPEG bytes.") },
            "image/png": { schema: z.string().describe("Raw PNG bytes.") },
            "image/webp": { schema: z.string().describe("Raw WebP bytes.") },
          },
        },
        "403": {
          description: "Caller is not the avatar's owner.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "The user has no uploaded avatar.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/profile": {
    get: {
      tags: ["Auth"],
      summary: "Read the calling user's profile",
      description:
        "Flattened profile fields for the native client. Aliased over the same data exposed by /api/auth/me. The KVNR is decrypted server-side; the IKNR (v1.8.6) is returned plaintext.",
      responses: {
        "200": {
          description: "The calling user's profile.",
          content: {
            "application/json": {
              schema: dataEnvelope(profileResponse, "GetProfileResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Update the calling user's profile",
      description:
        "Partial profile update — every field is optional. An explicit null (or empty string) clears a field. A non-empty `insurerIkNumber` must be exactly 9 digits (422 otherwise); a non-empty `insuranceNumber` (KVNR) must pass the mod-10 check. `userId` is never accepted from the body.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: profileUpdateRequest } },
      },
      responses: {
        "200": {
          description: "Saved profile echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                profileUpdateResponse,
                "PatchProfileResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/notification-prefs": {
    get: {
      tags: ["Notifications"],
      summary: "Read per-user notification preferences",
      description:
        "Returns the fully-resolved preferences with the documented defaults filled in. A null persisted row resolves to the defaults (server-managed reminders, low-stock threshold 7 days, mood reminder 22:00, Coach nudges on).",
      responses: {
        "200": {
          description: "Resolved preferences plus the `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                notificationPrefsResponse,
                "GetNotificationPrefsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Notifications"],
      summary: "Update per-user notification preferences",
      description:
        'Deep-merges the supplied partial shape over the persisted row — a PATCH touching only one category leaves the siblings intact. Always returns the fully-resolved next state so clients can hard-set their optimistic update. `medication.clientManaged: true` (or `deliveryDefault: "client"`) suppresses server-side MEDICATION_REMINDER APNs; `medication.lowStockRunwayDays` (1–60, nullable, default 7) tunes the low-stock alert — null switches it off. Rate-limit 60/min per user.',
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: notificationPrefsPatchRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state preferences echoed back with the fresh `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                notificationPrefsResponse,
                "PatchNotificationPrefsResponse",
              ),
            },
          },
        },
        ...conflictResponse409(
          "Notification preferences",
          "notification_prefs_conflict",
        ),
        ...stdResponses,
      },
    },
  },
};
