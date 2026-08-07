/**
 * OpenAPI route table — workouts list/detail/batch.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { measurementSourceEnum } from "@/lib/validations/measurement";
import { createBatchWorkoutSchema } from "@/lib/validations/workout";
import {
  MODULE_DISABLED_DESCRIPTION,
  dataEnvelope,
  errorEnvelope,
  moduleDisabledResponse,
  recordRefusal,
  stdResponses,
} from "./shared";

// v1.4.25 W16b — typed workout batch ingest response envelope. Mirrors
// the measurements batch shape but reports the `workouts` count rather
// than the entries count, and the `skipped` field is reserved (the
// Zod schema rejects malformed entries with a 400 before the per-entry
// pass, so today's responses always carry an empty array).
const workoutBatchEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z.enum(["inserted", "duplicate", "skipped"]),
    reason: z.string().optional(),
  })
  .meta({ id: "WorkoutBatchEntryResult" });

const workoutBatchResponse = z
  .object({
    processed: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    skipped: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
    entries: z.array(workoutBatchEntryResult),
  })
  .meta({ id: "WorkoutBatchResponse" });

// v1.4.32 — workout list / detail wire shape. The field names follow
// the iOS handoff contract (`distanceM` + `activeEnergyKcal`) rather
// than the Prisma column names so iOS and web consumers share one
// JSON envelope.
const workoutListEntry = z
  .object({
    id: z.string(),
    sportType: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    durationSec: z.number().int().nonnegative(),
    distanceM: z.number().nullable(),
    activeEnergyKcal: z.number().nullable(),
    avgHr: z.number().int().nullable(),
    maxHr: z.number().int().nullable(),
    source: measurementSourceEnum,
    externalId: z.string().nullable(),
    // #67 list glyphs — flags which sessions open into a rich detail.
    hasRoute: z.boolean(),
    hasHrSeries: z.boolean(),
  })
  .meta({ id: "WorkoutListEntry" });

const workoutListResponse = z
  .object({
    workouts: z.array(workoutListEntry),
    meta: z.object({
      total: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
      droppedDuplicates: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: "WorkoutListResponse" });

const workoutRouteGeometry = z
  .object({
    geometry: z.unknown(),
    sampleTimestamps: z.array(z.string()).nullable(),
  })
  .meta({ id: "WorkoutRouteGeometry" });

// v1.10.0 — route-independent per-workout heart-rate series. Present
// for indoor and outdoor workouts that shipped a `samples` array on
// ingest. `samples` mirrors the ingest shape `[{ t, hr?, speedMs?,
// power?, cadence? }]`; `sampleCount` is the denormalised length.
const workoutHrSeries = z
  .object({
    sampleCount: z.number().int().nonnegative(),
    samples: z.unknown(),
  })
  .meta({ id: "WorkoutHrSeries" });

// #67 — per-workout HR curve, one DTO with explicit provenance. Stored
// `WorkoutSamples` series first, raw PULSE-window reconstruction second.
const workoutHrCurve = z
  .object({
    source: z.enum(["workout_series", "pulse_window"]),
    bucketSec: z.number().int().positive(),
    points: z.array(
      z.object({
        tSec: z.number().int().nonnegative(),
        mean: z.number().int(),
        min: z.number().int(),
        max: z.number().int(),
      }),
    ),
    envelope: z.boolean(),
  })
  .meta({ id: "WorkoutHrCurve" });

// #67 — effort-zone distribution. WHOOP device durations win; else a
// %HRmax fold from the HR curve when profile age exists.
const workoutZones = z
  .object({
    model: z.enum(["whoop", "tanaka"]),
    hrMax: z.number().int().nullable(),
    zones: z.array(
      z.object({
        zone: z.number().int().min(1).max(5),
        lowBpm: z.number().int().nullable(),
        highBpm: z.number().int().nullable(),
        seconds: z.number().int().nonnegative(),
      }),
    ),
  })
  .meta({ id: "WorkoutZones" });

// #67 — per-kilometre splits, derived server-side from geometry +
// timestamps so the raw timestamp blob can be dropped under `compact=1`.
const workoutSplit = z
  .object({
    km: z.number().int().positive(),
    durationSec: z.number().int().nonnegative(),
    paceSecPerKm: z.number().int().nonnegative(),
  })
  .meta({ id: "WorkoutSplit" });

// #67 — own-history average for the sport (comparison line).
const workoutSportContext = z
  .object({
    count: z.number().int().nonnegative(),
    avgDurationSec: z.number().int().nonnegative(),
    avgDistanceM: z.number().nullable(),
    avgAvgHr: z.number().int().nullable(),
  })
  .meta({ id: "WorkoutSportContext" });

const workoutActivityInsight = z
  .object({
    /** Plain text. No markup of any kind — clients render it as text. */
    paragraph: z.string(),
    generatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "WorkoutActivityInsight" });

const workoutDetailResponse = z
  .object({
    id: z.string(),
    sportType: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    /**
     * The local calendar day the session belongs to, `YYYY-MM-DD`, resolved
     * server-side from `startedAt` in the user's timezone. Clients address
     * the day-scoped reads with it instead of deriving a day from the
     * timestamp in their own zone.
     */
    dayKey: z.string(),
    durationSec: z.number().int().nonnegative(),
    distanceM: z.number().nullable(),
    activeEnergyKcal: z.number().nullable(),
    avgHr: z.number().int().nullable(),
    maxHr: z.number().int().nullable(),
    minHr: z.number().int().nullable(),
    stepCount: z.number().int().nullable(),
    elevationM: z.number().nullable(),
    pauseDurationSec: z.number().int().nullable(),
    source: measurementSourceEnum,
    externalId: z.string().nullable(),
    metadata: z.unknown().nullable(),
    route: workoutRouteGeometry.nullable(),
    samples: workoutHrSeries.nullable(),
    // #67 enrichment — additive; absent from a pre-enrichment client's
    // expectations, opt-in `compact=1` only trims the raw blobs above.
    hrSeries: workoutHrCurve.nullable(),
    zones: workoutZones.nullable(),
    splits: z.array(workoutSplit).nullable(),
    sportContext: workoutSportContext.nullable(),
    // The per-workout Activity Insight. Additive-nullable and overwhelmingly
    // null: a paragraph exists only for a workout that landed while the
    // feature was live, over the duration floor, under the day's cap and with
    // a provider reachable. Reading this endpoint never generates one.
    aiInsight: workoutActivityInsight.nullable(),
    canonicalId: z.string(),
    /**
     * The canonical session before this one in the same sport, or null when
     * this is the first on record. Resolved through the same source-priority
     * picker as the list, so the id always addresses a row the list shows.
     */
    previousWorkoutId: z.string().nullable(),
  })
  .meta({ id: "WorkoutDetailResponse" });

export const workoutPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/workouts": {
    get: {
      tags: ["Measurements"],
      summary: "List workouts (v1.4.32)",
      description:
        "Paginated workout list with cross-source canonical-row dedup. The picker reads the per-user source-priority ladder and buckets by `(startedAt 5 min slot, sportType)` — twin workouts (Apple Watch + Withings ScanWatch) collapse to a single canonical row per cluster. Field names mirror the iOS handoff contract: `distanceM`, `activeEnergyKcal`, `avgHr`, `maxHr`.",
      requestParams: {
        query: z.object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
          since: z.iso.datetime({ offset: true }).optional(),
          until: z.iso.datetime({ offset: true }).optional(),
          sportType: z.string().optional(),
        }),
      },
      responses: {
        "200": {
          description: "Canonical workout page.",
          content: {
            "application/json": {
              schema: dataEnvelope(workoutListResponse, "ListWorkoutsResponse"),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/workouts/{id}": {
    get: {
      tags: ["Measurements"],
      summary: "Workout detail (v1.4.32)",
      description:
        "Single-workout envelope. Owns the optional `WorkoutRoute` GeoJSON geometry + `canonicalId` pointer that resolves to the cluster winner so deep-links into non-canonical twin rows can redirect cleanly. Additive enrichment fields (`hrSeries`, `zones`, `splits`, `sportContext`) are computed server-side. `aiInsight` is a pure read of a per-workout paragraph written by a background job when the workout landed; it is null for every workout that predates the feature or was re-synced, and reading this endpoint never generates one. `compact=1` (sent by the web client) drops the raw `samples.samples` HR blob and `route.sampleTimestamps` array from the response; without it the payload is byte-identical to the v1.4.32 contract. Cross-user rows surface as 404 (existence channel sealed).",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: z.object({
          compact: z.enum(["1"]).optional(),
        }),
      },
      responses: {
        "200": {
          description: "Workout detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(workoutDetailResponse, "GetWorkoutResponse"),
            },
          },
        },
        "404": {
          description: "Workout not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/workouts/batch": {
    post: {
      tags: ["Measurements"],
      summary: "Typed workout batch ingest (v1.4.25 W16b)",
      description:
        "Server-side ingest endpoint for HKWorkout records (iOS) and Withings activity rows (server-to-server). Up to 100 workouts per call; nested route geometry (GeoJSON LineString) is capped at 20 000 points and stored in a 1:1 `WorkoutRoute` row keyed by `workoutId`. Idempotent via the `Idempotency-Key` header (replay window 24h). Per-entry status (`inserted | duplicate | skipped`) lets the iOS sync cursor checkpoint accurately. The request body ceiling is 5 MB enforced at the HTTP layer — clients above the ceiling receive a 413 with `workout.batch.payload_too_large`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createBatchWorkoutSchema } },
      },
      responses: {
        "200": {
          description: "Batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                workoutBatchResponse,
                "BatchWorkoutsResponse",
              ),
            },
          },
        },
        "400": {
          description:
            "Batch validation failed (over-cap, schema reject, or oversized route).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Request body exceeds the 5 MB ceiling.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
