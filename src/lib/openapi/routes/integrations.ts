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
import { dataEnvelope, stdResponses } from "./shared";

// Mirror the route's `directionEnum` — per-metric sync direction.
const healthKitDirectionEnum = z
  .enum(["bidirectional", "readOnly", "writeOnly", "disabled"])
  .describe("Per-metric sync direction.");

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

const healthKitConfigResponse = z
  .object({
    entries: z.array(healthKitEntry),
    lastSyncedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "When HealthKit last synced for this user; null when never (and always null on the PATCH echo).",
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
};
