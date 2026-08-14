/**
 * OpenAPI route table — third-party integration config (HealthKit).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Response DTOs are declared here mirroring the route handler under
 * `src/app/api/integrations/healthkit/route.ts`; the request schema
 * mirrors the handler's `patchSchema`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
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
};
