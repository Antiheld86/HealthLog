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
import { SCORE_PILLAR_IDS } from "@/lib/analytics/score/types";
import { savedReportProfileSchema } from "@/lib/report-selection/profile-shape";
import { injectionSiteEnum } from "@/lib/validations/medication";
import {
  thresholdsUpdateSchema,
  ALL_METRICS,
} from "@/lib/validations/thresholds";
import type { ThresholdMetric } from "@/lib/analytics/effective-range";
import {
  documentsAutoAiReadPatchSchema,
  injectionSitePrefsPatchSchema,
  unitPreferencePatchSchema,
} from "@/lib/validations/user-prefs";
import {
  dataEnvelope,
  errorEnvelope,
  stdResponses,
  baseUpdatedAtField,
  updatedAtTokenField,
  conflictResponse409,
  invalidBaseTokenResponse,
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

// v1.35.0 — which pillars count toward the Health Score. Shipped with a
// settings surface in front of it and no published contract at all; the
// entry below is that contract, read off the route rather than inferred
// from a neighbour.
//
// The asymmetry is the thing to get right: the REQUEST speaks the positive
// selection (the pillars that should count, which is what a person picks),
// while the RESPONSE carries both sides resolved. The column itself stores
// the complement, but that is storage and no client ever sees it.

const scorePillarId = z
  .enum(SCORE_PILLAR_IDS)
  .meta({ id: "ScorePillarId", description: "A Health Score pillar id." });

const healthScoreConfigResponse = z
  .object({
    pillars: z
      .array(scorePillarId)
      .describe(
        "Registry-ordered pillars that count toward the score. Data availability narrows this further at score time, and that narrowing is not a choice — so this is the composition, not a promise that every pillar has a number today.",
      ),
    excludedPillars: z
      .array(scorePillarId)
      .describe("Registry-ordered pillars the person took out."),
    hasSelection: z
      .boolean()
      .describe(
        "True once a selection has been written. It says the person chose, not that their choice differs from the default: an account that opened the surface and kept every pillar has a selection. False means nobody ever chose, and such an account still inherits a later change of defaults.",
      ),
    version: z
      .number()
      .int()
      .describe(
        "Per-user recipe version, monotonic and incremented on every accepted write. 0 while no selection has been written. A score record names the version that produced it, so a comparison can see the recipe move.",
      ),
    changedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the recipe last changed; null while it never has."),
    updatedAt: updatedAtTokenField,
  })
  .meta({
    id: "HealthScoreConfigResponse",
    description:
      "The resolved Health Score composition. `updatedAt` is ABSENT while the account has never written a selection — there is nothing to guard a write against, so the first save is the unconditional write.",
  });

const healthScoreConfigPatchRequest = z
  .object({
    pillars: z
      .array(scorePillarId)
      .max(SCORE_PILLAR_IDS.length)
      .describe(
        "The pillars that should count — the positive selection, not the exclusions. Replaces the stored recipe whole; it never merges. An id outside the catalogue is a 422 rather than being dropped, because a client has no business sending one.",
      ),
    baseUpdatedAt: baseUpdatedAtField,
  })
  // Mirrors the runtime `.strict()`, so a generated client is told about
  // the rejection rather than only being told in prose.
  .strict()
  .meta({
    id: "PatchHealthScoreConfigRequest",
    description:
      "The pillars that should count toward the score. Strict: any key other than `pillars` and `baseUpdatedAt` is rejected.",
  });

// v1.28-era — the owner's saved doctor-report selection (leaf list plus the
// render choices the export panel restores). `v` is the report-selection
// schema version (currently locked at 2); `leaves` is a closed catalogue of
// section/field ids, canonicalised to a fixed order server-side so two
// clients that chose the same scope persist the same bytes. This is the ONLY
// request body for the PUT — it replaces the stored profile whole, it never
// merges.
const savedReportProfile = savedReportProfileSchema.meta({
  id: "SavedReportProfile",
  description:
    "A saved doctor-report scope: which leaves are included plus the export format, trailing window and chart toggle. Replace-only — there is no partial-merge write.",
});

const reportSelectionGetResponse = z
  .object({
    profile: savedReportProfile
      .nullable()
      .describe(
        "The saved profile, or null when the account has never saved one, or when the stored blob no longer parses against the current leaf catalogue. Null is never resolved to a default scope server-side — the client applies its own named template and shows that as a visible choice.",
      ),
  })
  .meta({ id: "GetReportSelectionResponse" });

const reportSelectionPutResponse = z
  .object({ profile: savedReportProfile })
  .meta({ id: "PutReportSelectionResponse" });

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
      .enum([
        "OPENAI",
        "ANTHROPIC",
        "LOCAL",
        "OPENAI_COMPATIBLE",
        "CHATGPT_OAUTH",
      ])
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
    compatBaseUrl: z
      .string()
      .nullable()
      .describe(
        "v1.33.1 (#470) — base URL of the OpenAI-compatible gateway (LiteLLM / OpenRouter / vLLM). Its own column: the OpenAI provider stays pinned to api.openai.com and never reads it.",
      ),
    compatModel: z
      .string()
      .nullable()
      .describe(
        "Model the gateway should route. Null falls back to `model`; with neither set the gateway entry does not resolve.",
      ),
    hasCompatKey: z
      .boolean()
      .describe(
        "Whether a bearer is stored for the gateway. The bearer is optional — a gateway without auth needs none.",
      ),
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

// ── Per-user preference scalars + threshold overrides ────────────────
// Four surfaces the iOS client has called since they shipped and that the
// registry never carried. The request bodies come from the validation modules
// the handlers themselves parse with, so the published wire cannot drift from
// the runtime one; the responses are shapes the handlers assemble by hand and
// are therefore described here.

const unitPreferencePatchRequest = unitPreferencePatchSchema.meta({
  id: "UnitPreferencePatchRequest",
  description:
    "Which display-unit branch to render. Presentation only — the stored measurement rows stay SI either way.",
});

const unitPreferenceResponse = z
  .object({ unitPreference: z.enum(["metric", "imperial"]) })
  .meta({ id: "UnitPreferenceResponse" });

const documentsAutoAiReadPatchRequest = documentsAutoAiReadPatchSchema.meta({
  id: "DocumentsAutoAiReadPatchRequest",
  description:
    "Turn automatic AI reading of newly uploaded documents on or off. Turning it on also mints an `ai_full` consent receipt and schedules a catch-up over the existing vault.",
});

const documentsAutoAiReadResponse = z
  .object({ documentsAutoAiRead: z.boolean() })
  .meta({ id: "DocumentsAutoAiReadResponse" });

const injectionSitePrefsPatchRequest = injectionSitePrefsPatchSchema.meta({
  id: "InjectionSitePrefsPatchRequest",
  description:
    "Replace the user-level injection-site deny-list. An empty array clears it.",
});

const injectionSitePrefsResponse = z
  .object({
    globalExcludedInjectionSites: z
      .array(injectionSiteEnum)
      .describe(
        "The stored deny-list, deduplicated and in canonical enum order.",
      ),
  })
  .meta({ id: "InjectionSitePrefsResponse" });

/**
 * The `?metric=` query enum, derived from the canonical metric list rather than
 * restated — `ALL_METRICS` is what the handler checks the parameter against, so
 * a metric added there cannot go missing from the published parameter.
 */
const thresholdMetricEnum = z
  .enum(ALL_METRICS as [ThresholdMetric, ...ThresholdMetric[]])
  .meta({ id: "ThresholdMetric" });

const trafficRange = z
  .object({
    greenMin: z.number(),
    greenMax: z.number(),
    orangeMin: z.number(),
    orangeMax: z.number(),
  })
  .meta({
    id: "TrafficRange",
    description:
      "A traffic-light band: green is the target window, the orange wings stretch either side of it and are clamped to the metric's physiological bounds.",
  });

const effectiveRange = z
  .object({
    range: trafficRange
      .nullable()
      .describe(
        "The band in force — the override when one is set, otherwise the computed default. Null when the default needs profile data the account has not supplied.",
      ),
    isOverride: z
      .boolean()
      .describe("Whether `range` came from a stored override."),
    default: trafficRange
      .nullable()
      .describe(
        "The unmodified computed default, so a client can render current-versus-default without recomputing it.",
      ),
    bounds: z
      .object({
        min: z.number(),
        max: z.number(),
        unit: z.string().describe("Canonical unit, e.g. `mmHg`, `kg`, `%`."),
      })
      .describe(
        "Outer physiological guardrails for this metric — the range an override must sit inside. Not a default.",
      ),
  })
  .meta({ id: "EffectiveRange" });

const thresholdOverrideMap = z
  .record(z.string(), z.object({ min: z.number(), max: z.number() }))
  .meta({
    id: "ThresholdOverrides",
    description:
      "Stored overrides, keyed by `ThresholdMetric`. Partial by construction — a metric absent from the map is on its computed default. `{}` means no override anywhere.",
  });

const thresholdsGetResponse = z
  .object({
    effective: z
      .record(z.string(), effectiveRange)
      .describe(
        "Every `ThresholdMetric`, resolved. Exhaustive: a metric with no override and no derivable default is present with a null `range`, not missing.",
      ),
    overrides: thresholdOverrideMap,
  })
  .meta({ id: "ThresholdsResponse" });

const thresholdsOverridesResponse = z
  .object({ overrides: thresholdOverrideMap })
  .meta({ id: "ThresholdsOverridesResponse" });

const thresholdsUpdateRequest = thresholdsUpdateSchema.meta({
  id: "ThresholdsUpdateRequest",
  description:
    "A partial map of `ThresholdMetric` to `{ min, max }`. Only the metrics named are written; the rest keep their existing override. Strict — an unknown key is a 422, not a silent drop. Each range must sit inside that metric's physiological bounds with `min` strictly below `max`.",
});

export const profilePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/user/ai-provider": {
    get: {
      tags: ["Auth"],
      summary: "Read the calling user's AI-provider configuration",
      description:
        "Returns the user's selected provider/model/baseUrl (plus the OpenAI-compatible gateway's own base URL and model) and the effective availability: `aiAvailable` is true when any provider can serve the user (BYOK, self-hosted, or the operator's server-managed key), and `managedBy` reports which. iOS gates Coach visibility off these two fields. Key material is reported as presence + a 4-char masked preview only.",
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
        ...invalidBaseTokenResponse,
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
  "/api/auth/me/health-score-config": {
    get: {
      tags: ["Auth"],
      summary: "Read which pillars count toward the Health Score",
      description:
        "v1.35.0 — the resolved composition: which pillars count, which the person took out, whether they have chosen at all, and the recipe version. An account that never chose reads every pillar with `hasSelection: false` and `version: 0`, which is exactly what its number was already built from — there is no backfill because there is nothing to back-fill.",
      responses: {
        "200": {
          description:
            "The resolved composition. `updatedAt` is absent until a selection has been stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthScoreConfigResponse,
                "HealthScoreConfigEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Choose which pillars count toward the Health Score",
      description:
        "Replaces the recipe with the given positive selection and bumps the per-user recipe version by one. The write is refused when the selection cannot produce a score: at least one physical measurement, and at least three distinct areas of health. Blood pressure, glucose and cholesterol are three pillars but one area, which is the refusal that surprises people. Accepting the write also evicts the account's score caches, so the next read reflects the new composition rather than the previous hour's number. Optimistic concurrency: send `baseUpdatedAt` from a prior read and the write 409s if the recipe moved since; omit it for the unconditional write. Rate-limited to 60 writes per minute per user.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: healthScoreConfigPatchRequest },
        },
      },
      responses: {
        "200": {
          description:
            "The stored composition, echoed back with the incremented `version` and the advanced `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthScoreConfigResponse,
                "PatchHealthScoreConfigEnvelope",
              ),
            },
          },
        },
        ...conflictResponse409(
          "Score selection",
          "health_score_config_conflict",
        ),
        ...stdResponses,
        // Four distinct 422s on one route, so this one is written out
        // rather than reusing the shared base-token response: a client
        // branching on `meta.errorCode` needs to see all of them, and a
        // description that named only the token would be a contract that
        // quietly omits the refusal a person actually hits.
        "422": {
          description:
            "The write was refused and nothing was stored. `meta.errorCode` distinguishes the cases: `health_score_config.too_narrow` — the selection cannot produce a score (`meta.reason` is `measured_physiological_domain_required` or `three_domains_required`, and the `error` string is the sentence to show the person); `health_score_config.invalid` — the body failed validation, with the per-issue list under `details.issues`; `invalid_base_updated_at` — `baseUpdatedAt` was present but unparseable, `null` included, which is rejected rather than falling back to the unconditional write. A body that is not JSON at all returns the bare message `health-score-config.body.invalid_json` with no errorCode.",
          content: { "application/json": { schema: errorEnvelope } },
        },
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
        ...invalidBaseTokenResponse,
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
        ...invalidBaseTokenResponse,
      },
    },
  },
  "/api/auth/me/report-selection": {
    get: {
      tags: ["Auth"],
      summary: "Read the owner's saved doctor-report selection",
      description:
        "Returns the saved report-scope profile, or `profile: null` when the account has never saved one (or the stored blob no longer parses against the current leaf catalogue). Replaces the retired `GET /api/auth/me/doctor-report-prefs`. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The saved profile, or null.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                reportSelectionGetResponse,
                "GetReportSelectionResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace the owner's saved doctor-report selection",
      description:
        "Replace, not merge — the body states the whole scope or it is not a scope; a leaf omitted from the body is a leaf removed from the saved profile. An unknown leaf id is refused with a 422 that names it. The saved selection is also what the FHIR REST face and the MCP doctor-visit surfaces replay for a caller that cannot ask a human, so every write is audit-logged. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: savedReportProfile } },
      },
      responses: {
        "200": {
          description: "The saved profile, echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                reportSelectionPutResponse,
                "PutReportSelectionResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  // ── Appended: preference surfaces the iOS client calls that the registry
  // never carried. All four take a cookie session or a wildcard Bearer token
  // (`requireAuth()` with no declared scope), none are delegable — a request
  // that attaches an account selector is refused before the handler runs — and
  // every PATCH/PUT is a hard-set that answers with the resolved next state, so
  // a client replaces its optimistic value rather than re-reading.
  "/api/auth/me/unit-preference": {
    get: {
      tags: ["Auth"],
      summary: "Read the metric/imperial display preference",
      description:
        "Which branch of the display-time transform registry the client should render (km/h vs mph, km vs mi). Canonical storage stays SI on every measurement row — this changes presentation only, and never what was written. Any stored value other than `imperial` resolves to `metric`, including a null on an account that predates the column.",
      responses: {
        "200": {
          description: "The resolved preference.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                unitPreferenceResponse,
                "GetUnitPreferenceEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Set the metric/imperial display preference",
      description:
        "Hard-set, idempotent, audit-logged. Rate-limited 60 / min per user.\n\n" +
        "The body is capped at 1 KB and must carry `Content-Type: application/json`. Anything larger is 413, a wrong content type is 415, and a body that is not JSON at all is 400 — the same three the other scalars in this group answer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: unitPreferencePatchRequest },
        },
      },
      responses: {
        "200": {
          description: "The resolved next preference.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                unitPreferenceResponse,
                "PatchUnitPreferenceEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Request body exceeds 1024 bytes. Nothing was written.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/documents-auto-ai-read": {
    get: {
      tags: ["Auth"],
      summary: "Read the automatic document-reading opt-in",
      description:
        "Whether the auto-index-on-upload job may read a freshly uploaded document through the account's configured external provider with no per-document tap. OFF by default and off for any account that has never set it: the vault is local-first and every egress otherwise needs an explicit action plus an active consent receipt.",
      responses: {
        "200": {
          description: "The current flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                documentsAutoAiReadResponse,
                "GetDocumentsAutoAiReadEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Set the automatic document-reading opt-in",
      description:
        "Hard-set, idempotent, audit-logged. Rate-limited 60 / min per user.\n\n" +
        "Turning it ON does two further things a caller should expect. It is itself the standing consent act, so the write appends an `ai_full` `ConsentReceipt` — the same receipt POST /api/consent/ai/web mints, and one DELETE /api/consent/ai/latest revokes without touching this flag. And a genuine OFF→ON flip schedules a bounded catch-up over the documents already in the vault, because the summary job is enqueued at upload time and would otherwise only ever apply to future uploads. The catch-up is fire-and-forget and re-runs every consent and budget gate per document.\n\n" +
        "The body cap here is 1 KB, far tighter than the 64 KB its siblings allow — a payload above it is refused with 413 rather than parsed.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: documentsAutoAiReadPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "The resolved next flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                documentsAutoAiReadResponse,
                "PatchDocumentsAutoAiReadEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Request body exceeds 1024 bytes. Nothing was written.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/injection-site-prefs": {
    get: {
      tags: ["Auth"],
      summary: "Read the user-level injection-site deny-list",
      description:
        "Sites the account never wants offered. The list is a DENY, and deny wins everywhere: a site here is dropped from every medication's injection-site picker and refused at intake with 422, even when that medication names it among its preferred sites.",
      responses: {
        "200": {
          description: "The current deny-list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                injectionSitePrefsResponse,
                "GetInjectionSitePrefsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Replace the user-level injection-site deny-list",
      description:
        "Replace, not merge — the body states the whole list, and an empty array clears the exclusion. Hard-set, idempotent, audit-logged. Rate-limited 60 / min per user.\n\n" +
        "The stored list is deduplicated and re-ordered into the canonical enum order before it is written, so the response can differ from the body that produced it while describing the same set. Take the response as the state.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: injectionSitePrefsPatchRequest },
        },
      },
      responses: {
        "200": {
          description:
            "The resolved next deny-list, deduplicated and in canonical order.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                injectionSitePrefsResponse,
                "PatchInjectionSitePrefsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/thresholds": {
    get: {
      tags: ["Analytics"],
      summary: "Read the effective metric ranges and the caller's overrides",
      description:
        "Every threshold metric with its resolved traffic-light band, whether that band came from an override, the unmodified computed default beside it, and the metric's physiological bounds — so a settings surface can show current-versus-default and validate an edit without a second call.\n\n" +
        "`range` and `default` are nullable: a metric whose default is derived from profile data the account has not supplied (height for weight, date of birth and gender for body fat) has no band to resolve until that data exists.",
      responses: {
        "200": {
          description: "Effective ranges plus the stored overrides.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                thresholdsGetResponse,
                "GetThresholdsEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "The authenticated user row could not be loaded. In practice unreachable — the session that resolved the caller was validated against that row.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Analytics"],
      summary: "Set threshold overrides for one or more metrics",
      description:
        "MERGE, not replace, and it is the one write on this surface that behaves that way: the body is a partial map and only the metrics it names are touched. A metric omitted keeps whatever override it already had. To remove one, use DELETE with `?metric=` — sending it back as an absent key does nothing.\n\n" +
        "Each range must sit inside that metric's physiological bounds with `min` strictly below `max`, and an unknown metric key is refused rather than ignored (the schema is strict). Rate-limited 30 / 5 min per user; audit-logged with the before and after maps. The response carries the merged override map, not the recomputed effective ranges — re-read the GET for those.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: thresholdsUpdateRequest } },
      },
      responses: {
        "200": {
          description: "The merged override map.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                thresholdsOverridesResponse,
                "PutThresholdsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Analytics"],
      summary: "Reset one threshold override, or all of them",
      description:
        "With `?metric=` it drops that metric's override; WITHOUT the parameter it drops EVERY override on the account. There is no confirmation step and no dry run, so a client that means to reset one metric must send the parameter.\n\n" +
        "Audit-logged with the before and after maps. Unlike the PUT this path runs no rate limit of its own.",
      requestParams: {
        query: z.object({
          metric: thresholdMetricEnum
            .optional()
            .describe(
              "The single metric to reset. Omit to reset every override on the account.",
            ),
        }),
      },
      responses: {
        "200": {
          description: "The remaining override map.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                thresholdsOverridesResponse,
                "DeleteThresholdsEnvelope",
              ),
            },
          },
        },
        "400": {
          description:
            "`metric` was present but is not a known threshold metric. Nothing was reset.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
