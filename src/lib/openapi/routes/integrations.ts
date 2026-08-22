/**
 * OpenAPI route table — third-party integration config (HealthKit) and the
 * per-provider connection surfaces (Nightscout / WHOOP / Withings).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Response DTOs are declared here mirroring the route handler under
 * `src/app/api/integrations/healthkit/route.ts`; the request schema
 * mirrors the handler's `patchSchema`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { whoopCredentialsSchema } from "@/lib/validations/whoop";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// Mirror the route's `directionEnum` — per-metric sync direction.
const healthKitDirectionEnum = z
  .enum(["bidirectional", "readOnly", "writeOnly", "disabled"])
  .describe("Per-metric sync direction.");

// Mirror the batch route's `syncTriggerEnum` — what woke the client for a sync.
const healthKitSyncTriggerEnum = z
  .enum(["foreground", "background", "push"])
  .describe("What triggered a HealthKit batch.");

// Resolved entry (defaults merged): `kind` + `enabled` are always present.
const healthKitEntry = z
  .object({
    id: z.string().describe("Stable metric key (e.g. `bodyMass`)."),
    kind: z.string().describe("HealthKit sample kind (e.g. `bloodPressure`)."),
    direction: healthKitDirectionEnum,
    enabled: z.boolean(),
  })
  .meta({
    id: "HealthKitEntry",
    description:
      "One resolved HealthKit metric mapping (defaults merged with the user's stored overrides).",
  });

// Mirrors `src/lib/integrations/sync-verdict.ts` — the server-resolved liveness
// verdict. Apple Health is push-based, so only the data-age arms apply.
const syncHealth = z
  .object({
    verdict: z
      .enum([
        "fresh",
        "stale",
        "stalled",
        "failing",
        "reauth_required",
        "parked",
        "pending_first_sync",
        "disconnected",
      ])
      .describe(
        "Liveness verdict. For Apple Health: `fresh` when data arrived within the last 7 days, `stale` when it did not, `pending_first_sync` when none ever arrived.",
      ),
    since: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("The instant that triggered the verdict; null when none did."),
  })
  .meta({
    id: "SyncHealth",
    description:
      "Server-resolved sync-health verdict. The single source of liveness truth — `lastSyncedAt` alone cannot express 'this pipe stopped delivering'.",
  });

const metricFreshnessEntry = z
  .object({
    type: z
      .string()
      .describe(
        "The measurement type (e.g. `RESPIRATORY_RATE`), or `WORKOUTS` for the workout leg.",
      ),
    lastSeenAt: z.iso
      .datetime({ offset: true })
      .describe("Newest recorded reading for this type from this source."),
    stale: z
      .boolean()
      .describe(
        "This type has gone quiet while the source around it reads healthy — the dead-pipe signature (e.g. a single revoked HealthKit permission). Only ever true when the verdict is `fresh`.",
      ),
  })
  .meta({
    id: "MetricFreshnessEntry",
    description:
      "Per-metric-type last-seen timestamp with the server-computed staleness flag. Only types that have actually delivered appear — absence is absence, never an invented row.",
  });

// Issue #778 — the two backfill-progress figures the server genuinely holds.
// The iOS app drives the backfill; its queue, throttle state, and any ETA
// live on the device and are deliberately absent here.
const appleHealthSyncProgress = z
  .object({
    recordsAccepted: z
      .number()
      .int()
      .describe(
        "Measurement + workout rows carrying the `APPLE_HEALTH` source (live batch ingest and the one-shot export import both write it). Soft-deleted measurement rows are excluded.",
      ),
    oldestMeasuredAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Earliest instant reached across those rows (`measuredAt` for measurements, `startedAt` for workouts); null when nothing has arrived. During a first-run backfill this walks backwards as history lands.",
      ),
  })
  .meta({
    id: "AppleHealthSyncProgress",
    description:
      "Server-side Apple Health backfill progress: how many rows have been accepted and how far back in time they reach. Only what the server actually knows — no ETA, no device-side queue state.",
  });

const healthKitConfigResponse = z
  .object({
    entries: z.array(healthKitEntry),
    lastSyncedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "When HealthKit last synced for this user; null when never (and always null on the PATCH echo).",
      ),
    lastSyncTrigger: healthKitSyncTriggerEnum
      .nullable()
      .optional()
      .describe(
        "What the client declared triggered the most recent accepted batch. Null when the client sent no trigger — an older build, or a batch that predates the field. Present on the GET read; omitted from the PATCH echo.",
      ),
    lastBackgroundSyncAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe(
        "When a batch last arrived without the app being opened (a `background` or `push` trigger). Null when that has never happened. `lastSyncedAt` alone cannot separate a phone that delivers on its own from one that only delivers while the app is open; this field is what does. Present on the GET read; omitted from the PATCH echo.",
      ),
    syncHealth: syncHealth
      .optional()
      .describe("Present on the GET read; omitted from the PATCH echo."),
    metricFreshness: z
      .array(metricFreshnessEntry)
      .optional()
      .describe(
        "Per-metric-type freshness for the `APPLE_HEALTH` source. Present on the GET read; omitted from the PATCH echo.",
      ),
    syncProgress: appleHealthSyncProgress
      .nullable()
      .optional()
      .describe(
        "Backfill/sync progress summary. Present on the GET read (null when the progress read failed); omitted from the PATCH echo.",
      ),
  })
  .meta({
    id: "HealthKitConfigResponse",
    description:
      "The resolved HealthKit integration config: the default metric set merged with the user's stored per-metric overrides, plus the sync-health verdict and per-metric freshness.",
  });

// Mirror the route's `patchSchema` — merge-by-id; unknown ids are ignored.
const healthKitPatchEntry = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(64).optional(),
  direction: healthKitDirectionEnum,
  enabled: z.boolean().optional(),
});

const healthKitPatchRequest = z
  .object({
    entries: z.array(healthKitPatchEntry).max(50),
  })
  .meta({
    id: "HealthKitConfigPatchRequest",
    description:
      "Merge-by-`id` update of the HealthKit metric config. Unknown ids are silently ignored; omitted fields fall back to the stored (or default) value for that entry. Up to 50 entries per call.",
  });

// v1.32.28 — on-demand provider sync trigger. Identical response shape
// across Oura / Polar / Strava / Nightscout (`resolveSyncOutcome`), so a
// client renders one outcome card for all four. `outcome` is the
// server-resolved tone, never derived from the HTTP status alone: 200 is the
// transport succeeding, not the write — a run where every row was refused
// still answers 200 with `outcome: "failed"`.
const providerSyncOutcome = z
  .object({
    imported: z
      .number()
      .int()
      .describe("Rows that reached the database this run."),
    failed: z
      .boolean()
      .describe(
        "True when any part of the run did not land — a row, a collection, a leg.",
      ),
    outcome: z
      .enum(["empty", "failed", "partial", "success"])
      .describe(
        "`empty` — nothing new, nothing refused. `failed` — nothing written, something refused. `partial` — some written, some refused. `success` — everything written.",
      ),
  })
  .meta({
    id: "ProviderSyncOutcome",
    description:
      "The result of an on-demand provider sync trigger. No request body; the sync window is derived server-side from the newest row already held, never a client-supplied lookback.",
  });

// v1.32.x — Google Health background sync progress. Mirrors
// `GoogleHealthResourceOutcome` / the route's `resource()` sanitiser
// (`src/app/api/google-health/sync/status/route.ts`): every field is
// re-clamped/re-checked against a closed enum on read, so this documents
// the SANITISED wire shape, not the raw stored blob.
const googleHealthResourceOutcome = z
  .object({
    resource: z
      .string()
      .describe(
        "Resource collection name, lower-cased and slug-sanitised (`[^a-z0-9-]` stripped), capped at 48 chars. `unknown` when the stored value was not a string.",
      ),
    pages: z.number().int().min(0),
    fetched: z.number().int().min(0),
    mapped: z.number().int().min(0),
    written: z.number().int().min(0),
    status: z
      .enum(["pending", "complete", "partial", "empty", "truncated", "failed"])
      .describe(
        "Falls back to `failed` when the stored value is not one of this closed set.",
      ),
    durationMs: z.number().int().min(0),
    truncated: z.boolean(),
    reasonCode: z
      .enum([
        "collection_failed",
        "token_failed",
        "upsert_failed",
        "rollup_failed",
        "existing_page_limit",
      ])
      .nullable()
      .describe(
        "Null when the stored value is not one of this closed set, or when the resource did not fail.",
      ),
  })
  .meta({ id: "GoogleHealthResourceOutcome" });

const googleHealthSyncStatusResponse = z
  .object({
    runId: z.string().describe("Truncated to 128 chars."),
    state: z
      .enum([
        "in_progress",
        "complete",
        "partial",
        "zero",
        "truncated",
        "failed",
        "interrupted",
      ])
      .describe(
        "Falls back to `failed` when the stored value is not one of this closed set.",
      ),
    startedAt: z.string().describe("ISO instant, or empty string when unset."),
    updatedAt: z.string().describe("ISO instant, or empty string when unset."),
    terminalAt: z
      .string()
      .optional()
      .describe(
        "ISO instant the run reached a terminal state. Present only once the run has finished; absent while `state` is `in_progress`.",
      ),
    imported: z.number().int().min(0),
    failed: z.boolean(),
    resources: z
      .array(googleHealthResourceOutcome)
      .max(16)
      .describe("Per-collection outcome for this run, capped at 16 entries."),
  })
  .nullable()
  .meta({
    id: "GoogleHealthSyncStatusResponse",
    description:
      "The caller's current/most-recent Google Health sync run, or null when none has ever run. `data` carries this shape directly (not nested under a named key).",
  });

// ── Per-provider connection surfaces ─────────────────────────────────
// Nightscout / WHOOP / Withings each expose a status read plus a teardown.
// They answered iOS since v1.11 and were absent from the registry entirely,
// so nothing below is new behaviour — it is the shape the handlers already
// send, written down.

// Mirrors `IntegrationState` in `src/lib/integrations/status.ts`. The ledger
// records what the last ATTEMPT did; the verdict in `syncHealth` is what says
// whether the pipe is still alive. Both are published because they answer
// different questions and a client that reads only `state` cannot tell a row
// retrying hourly from one that stopped being tried at all.
const integrationLedgerState = z
  .enum([
    "connected",
    "error_transient",
    "error_reauth",
    "disconnected",
    "parked",
  ])
  .describe(
    "Last recorded ledger state for this provider. `connected` is also the value a user who has never synced sees — the ledger row is created on the first attempt, and its absence reads as `connected`, not as an error.",
  );

const nightscoutStatusResponse = z
  .object({
    connected: z
      .boolean()
      .describe(
        "A connection exists. Not a liveness claim — a pipe dead for a fortnight still answers `true`; read `syncHealth.verdict` for that.",
      ),
    configured: z
      .boolean()
      .describe("An instance URL is stored. The connect marker."),
    hasToken: z
      .boolean()
      .optional()
      .describe(
        "Whether an API token is stored alongside the URL. A fully-public Nightscout instance needs none, so `false` is not a misconfiguration. The token itself is never returned.",
      ),
    allowPrivateHost: z
      .boolean()
      .optional()
      .describe(
        "The operator has approved this user's private-origin (RFC 1918 / loopback / link-local) Nightscout instance. False for every public instance.",
      ),
    state: integrationLedgerState.optional(),
    lastSuccessAt: z.iso.datetime({ offset: true }).nullable().optional(),
    lastAttemptAt: z.iso.datetime({ offset: true }).nullable().optional(),
    lastError: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Last recorded failure message, decrypted from the ledger. Null when the last attempt succeeded or none has run.",
      ),
    syncHealth: syncHealth.optional(),
  })
  .meta({
    id: "NightscoutStatusResponse",
    description:
      "Nightscout connection status. When nothing is configured the body is exactly `{ connected: false, configured: false }` — every other field is absent, not null. The stored instance URL is the user's own and is NOT echoed here; the API token never is.",
  });

const nightscoutTestResponse = z
  .object({
    ok: z.literal(true),
    latencyMs: z
      .number()
      .int()
      .describe("Round-trip time of the single-entry probe, in milliseconds."),
  })
  .meta({
    id: "NightscoutTestResponse",
    description:
      "A live probe that reached the configured instance and read one SGV entry. Only ever returned on success — a failed probe is an error status, never `ok: false`.",
  });

const whoopCredentialsStatusResponse = z
  .object({
    hasCredentials: z
      .boolean()
      .describe(
        "Both the client id and the client secret are stored. Neither value is ever returned.",
      ),
  })
  .meta({
    id: "WhoopCredentialsStatusResponse",
    description:
      "Presence check for the per-user WHOOP BYO-key credentials. Presence only: this endpoint has no read path for the stored id or secret.",
  });

const whoopCredentialsRequest = whoopCredentialsSchema.meta({
  id: "WhoopCredentialsRequest",
  description:
    "Per-user WHOOP BYO-key credentials. Each self-hoster registers their own WHOOP developer app — the per-app authorized-user cap makes one shared app unworkable for a multi-operator product. Both values are trimmed (a trailing space from the portal's copy button reaches WHOOP verbatim and answers as 'unknown client') and stored encrypted at rest. Write-only: no endpoint reads them back.",
});

const whoopStatusResponse = z
  .object({
    connected: z
      .boolean()
      .describe("A WHOOP connection row exists and carries a WHOOP user id."),
    configured: z
      .boolean()
      .describe("Per-user BYO-key client id AND secret are both stored."),
    lastSyncedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe("Null when no sync has completed yet."),
    connectedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("When the connection row was created."),
    tokenExpired: z
      .boolean()
      .optional()
      .describe(
        "The stored access token's expiry is in the past. Read straight off the row — unlike the Withings status read, this endpoint does not refresh; the sync path refreshes lazily instead.",
      ),
    tokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
    backfillCompleted: z
      .boolean()
      .optional()
      .describe(
        "The self-converging history backfill has walked every collection to completion.",
      ),
    scope: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Space-separated OAuth scope string granted by WHOOP. Null on a legacy connection that predates scope tracking.",
      ),
  })
  .meta({
    id: "WhoopStatusResponse",
    description:
      "WHOOP connection status. When no connection row carries a WHOOP user id the body is exactly `{ connected: false, configured }` — every other field is absent, not null.",
  });

const withingsStatusResponse = z
  .object({
    connected: z.boolean().describe("A Withings connection row exists."),
    configured: z
      .boolean()
      .describe("Per-user client id AND secret are both stored."),
    lastSyncedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    connectedAt: z.iso.datetime({ offset: true }).optional(),
    tokenExpired: z
      .boolean()
      .optional()
      .describe(
        "True after a refresh attempt that did not produce a live token.",
      ),
    tokenRefreshFailed: z
      .boolean()
      .optional()
      .describe(
        "The read tried to refresh an expired token and could not — either the per-user credentials are gone or Withings refused. A permanently revoked grant additionally parks the ledger at `error_reauth` as a side effect of this read.",
      ),
    tokenExpiresAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Post-refresh expiry when the read refreshed, the stored expiry otherwise.",
      ),
    scope: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Comma-separated OAuth scope string from the authorisation flow. Null on a legacy connection that has never re-authed.",
      ),
    hasActivityScope: z
      .boolean()
      .optional()
      .describe(
        "Pre-computed convenience flag the reconnect banner reads. A null `scope` counts as missing activity.",
      ),
  })
  .meta({
    id: "WithingsStatusResponse",
    description:
      "Withings connection status. When no connection row exists the body is exactly `{ connected: false, configured }` — every other field is absent, not null. Note that this read is not side-effect free: a token within 60 s of expiry is refreshed and re-persisted before the response is built, so a GET here can rotate the stored token.",
  });

export const integrationPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/integrations/healthkit": {
    get: {
      tags: ["Integrations"],
      summary: "Read the HealthKit integration config",
      description:
        "Returns the resolved per-metric HealthKit config — the default metric set merged with the user's stored overrides — plus the last HealthKit sync instant. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Resolved HealthKit config.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthKitConfigResponse,
                "HealthKitConfigEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Integrations"],
      summary: "Update the HealthKit integration config",
      description:
        "Merges the supplied entries into the stored config by `id` (unknown ids are ignored) and returns the resolved config (defaults merged) so the client always sees a complete metric list. `lastSyncedAt` is null on the echo. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: healthKitPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "Updated + resolved HealthKit config.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthKitConfigResponse,
                "HealthKitConfigPatchEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/oura/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger an on-demand Oura sync",
      description:
        "Runs the same sync entry point the hourly cron uses. No body: the window is derived from the newest row already held, not a client-supplied lookback. Rate-limited 5 requests / 60s per user.",
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(providerSyncOutcome, "OuraSyncEnvelope"),
            },
          },
        },
        "502": {
          description:
            "The sync failed upstream. The classified failure is already recorded on the `oura` ledger; the response body carries no upstream detail.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/polar/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger an on-demand Polar sync",
      description:
        "Runs both Polar legs (vitals then workouts) through the same entry point the hourly poll uses, each with its own failure recording. No body: there is no full-history arm to call. Rate-limited 5 requests / 60s per user.",
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(providerSyncOutcome, "PolarSyncEnvelope"),
            },
          },
        },
        "502": {
          description:
            "The sync failed upstream. The classified failure is already recorded on the `polar` ledger; the response body carries no upstream detail.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/strava/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger an on-demand Strava sync",
      description:
        "Incremental from the stored Strava cursor (`stravaLastActivityAt` minus an overlap) — a manual run picks up wherever the last one stopped. No body and no full-history arm; deep history belongs to the connect-time backfill queue. `failed` is always `false` on a 200: the underlying walk rethrows on the first row error rather than settling partially, so reaching a 200 means every fetched activity was written. Rate-limited 5 requests / 60s per user.",
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(providerSyncOutcome, "StravaSyncEnvelope"),
            },
          },
        },
        "502": {
          description:
            "The sync failed upstream. The classified failure is already recorded on the `strava` ledger; the response body carries no upstream detail.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/nightscout/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger an on-demand Nightscout sync",
      description:
        "Pulls the recent SGV window from the configured Nightscout instance. No body: there is no full-history arm to call. The error body is always a fixed message, never the caught error's own — a Nightscout base URL carries its API token as a query parameter, so an upstream message could leak it. Rate-limited 5 requests / 60s per user.",
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                providerSyncOutcome,
                "NightscoutSyncEnvelope",
              ),
            },
          },
        },
        "502": {
          description:
            "The sync failed upstream. The classified failure is already recorded on the `nightscout` ledger; the response body carries no upstream detail.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The configured Nightscout origin is private (RFC 1918 / loopback / link-local) and the server operator has not approved private-origin access for this deployment.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/google-health/sync/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Google Health sync progress",
      description:
        'Returns only the authenticated user\'s own bounded current/most-recent sync run; there is no way to address another run or another connection\'s progress by query parameter (query parameters are ignored by construction). Every field is re-clamped and re-checked against its closed enum on read, so a malformed or legacy stored blob degrades to safe defaults (e.g. `state: "failed"`, `resource: "unknown"`) rather than reaching the client verbatim. Auth via cookie or Bearer.',
      responses: {
        "200": {
          description:
            "The current/most-recent run, or `data: null` when none has ever run.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                googleHealthSyncStatusResponse,
                "GoogleHealthSyncStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/nightscout/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Nightscout connection status",
      description:
        "Returns the connect marker plus the shared `nightscout` ledger snapshot and the server-resolved liveness verdict, so the Settings card and the iOS client paint the same pill from one read. The stored API token is never returned — `hasToken` reports its presence and nothing more. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nightscoutStatusResponse,
                "NightscoutStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/nightscout/test": {
    post: {
      tags: ["Integrations"],
      summary: "Probe the configured Nightscout instance",
      description:
        "Pulls a single SGV entry through the same client the sync uses, to re-validate the stored URL and token without waiting for a sync window. No body. Nothing is written: this neither ingests the entry nor touches the ledger. Rate-limited 5 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The probe reached the instance.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nightscoutTestResponse,
                "NightscoutTestEnvelope",
              ),
            },
          },
        },
        "502": {
          description:
            "The probe did not complete. `meta.errorCode` names the class: `credentials_rejected` (401/403 from Nightscout), `rate_limited` (429 from Nightscout — distinct from this endpoint's own 429), `upstream_error` (5xx), `timeout` (no answer within 5 s), `url_not_public` (the stored origin resolves to a private host and the operator has not approved it), `connection_failed` (everything else). The message is fixed per class and never the caught error's own: a Nightscout base URL carries its API token as a query parameter, so an upstream message could leak it.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "No Nightscout instance is configured for this user. `meta.errorCode` = `not_configured`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 5 probes in 60 s from this user. `meta.errorCode` = `rate_limited_self` — this is the local limiter, not Nightscout's.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/nightscout/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect the caller's Nightscout instance",
      description:
        "Clears the stored URL, token and private-host approval, and parks the `nightscout` ledger at `disconnected`. Glucose rows already ingested are left in place — this stops future syncs, it does not delete history. No body. Rate-limited 20 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The connection was cleared.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ disconnected: z.literal(true) }),
                "NightscoutDisconnectEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No Nightscout connection to clear. Note that this is NOT an idempotent no-op: a second disconnect answers 404 rather than 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/whoop/credentials": {
    get: {
      tags: ["Integrations"],
      summary: "Check whether WHOOP BYO-key credentials are stored",
      description:
        "Presence only. There is no read path for the stored client id or secret — the response carries a single boolean. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credential presence.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                whoopCredentialsStatusResponse,
                "WhoopCredentialsStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Integrations"],
      summary: "Store the caller's WHOOP BYO-key credentials",
      description:
        "Replaces both values; there is no partial update. Both are encrypted at rest and never read back. Body capped at 64 KiB. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: whoopCredentialsRequest },
        },
      },
      responses: {
        "200": {
          description: "Credentials stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ updated: z.literal(true) }),
                "WhoopCredentialsUpdateEnvelope",
              ),
            },
          },
        },
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
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Integrations"],
      summary: "Delete the caller's WHOOP credentials and connection",
      description:
        "Deletes the connection row (with its encrypted OAuth tokens), clears both credential columns, audits the teardown and parks the `whoop` ledger at `disconnected`. Idempotent: a missing connection row is a benign no-op, so a repeat call still answers 200. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credentials and connection removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.literal(true) }),
                "WhoopCredentialsDeleteEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/whoop/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's WHOOP connection status",
      description:
        "Reports the BYO-key configuration marker plus the connection row's last sync, token expiry, granted scope and backfill progress. Read-only — token refresh happens lazily on the sync path, not here. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(whoopStatusResponse, "WhoopStatusEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/withings/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Withings connection status",
      description:
        "Reports the per-user credential marker plus the connection row's last sync, token expiry and granted scope. Not side-effect free: a token within 60 s of expiry is refreshed and the new pair re-persisted before the response is built, so the reported `tokenExpiresAt` may be newer than the stored one was at request time, and a permanently revoked grant parks the ledger at `error_reauth` during this read. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                withingsStatusResponse,
                "WithingsStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/withings/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect the caller's Withings account",
      description:
        "Best-effort unsubscribes every webhook category, deletes the connection row, audits the teardown and parks the `withings` ledger at `disconnected`. A failing unsubscribe (expired token, category never subscribed) does not stop the teardown. Measurements already ingested are left in place. No body. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The connection was removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ disconnected: z.literal(true) }),
                "WithingsDisconnectEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No Withings connection to remove. Note that this is NOT an idempotent no-op: a second disconnect answers 404 rather than 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
