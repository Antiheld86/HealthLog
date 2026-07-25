/**
 * Per-metric-type freshness (the smallest honest signal).
 *
 * Freshness was tracked only per-integration (`IntegrationStatus.lastSuccessAt`
 * / a connection's `lastSyncedAt`). A provider that returns HTTP 200 with an
 * empty body for ONE data type produces zero rows, throws nothing, and the
 * other types in the same cycle stamp the whole integration green — so the
 * Settings pill reads "connected · 5 min ago" while, say, respiratory rate has
 * been dead since launch, and nothing distinguishes "broken pipe" from "healthy
 * but idle".
 *
 * This computes the last-value timestamp per `(source, type)` straight from the
 * `Measurement` table (no schema change, no migration) so a caller can surface
 * per-metric liveness honestly: a metric whose newest reading is frozen weeks in
 * the past is visibly distinct from one that is genuinely current. The
 * classification of "quiet" vs "current" is a pure function next to the verdict
 * (`classifyMetricFreshness` in `./sync-verdict`); this module only reads.
 *
 * Two sources write no `Measurement` rows for part of what they deliver:
 * Strava writes only `Workout` rows, and Polar's workout leg is one of its two
 * cron legs. A second grouped read over `Workout` appends a `WORKOUTS`
 * pseudo-entry so those pipes are visible too.
 */
import { prisma } from "@/lib/db";
import type { MeasurementSource } from "@/generated/prisma/client";
import type { IntegrationKey } from "./status";
import {
  WORKOUT_FRESHNESS_TYPE,
  type MetricFreshnessSample,
} from "./sync-verdict";

export type {
  MetricFreshnessEntry,
  MetricFreshnessSample,
} from "./sync-verdict";

/**
 * The `MeasurementSource` each sync integration's rows carry. `moodlog` is
 * absent — it writes `MoodEntry` rows, not `Measurement` rows, so it has no
 * per-metric measurement freshness. `strava` is absent from the measurement
 * map for the same reason and picks up its `WORKOUTS` entry below.
 */
export const INTEGRATION_MEASUREMENT_SOURCE: Partial<
  Record<IntegrationKey, MeasurementSource>
> = {
  withings: "WITHINGS",
  whoop: "WHOOP",
  fitbit: "FITBIT",
  nightscout: "NIGHTSCOUT",
  polar: "POLAR",
  oura: "OURA",
  "google-health": "GOOGLE_HEALTH",
};

/**
 * The `MeasurementSource` each workout-writing integration's `Workout` rows
 * carry. Strava is workouts-only; Polar syncs workouts alongside its
 * measurements.
 */
export const INTEGRATION_WORKOUT_SOURCE: Partial<
  Record<IntegrationKey, MeasurementSource>
> = {
  strava: "STRAVA",
  polar: "POLAR",
};

/**
 * Newest measurement per `(source, type)` for the given sources. One grouped
 * query; a `(source, type)` pair with no rows simply has no entry, which is how
 * honest absence stays structural — a metric a provider never delivered is
 * never invented.
 */
export async function getMeasurementFreshnessBySource(
  userId: string,
  sources: readonly MeasurementSource[],
): Promise<Map<MeasurementSource, MetricFreshnessSample[]>> {
  const out = new Map<MeasurementSource, MetricFreshnessSample[]>();
  if (sources.length === 0) return out;

  const grouped = await prisma.measurement.groupBy({
    by: ["source", "type"],
    where: { userId, deletedAt: null, source: { in: [...sources] } },
    _max: { measuredAt: true },
  });

  for (const row of grouped) {
    const lastSeen = row._max.measuredAt;
    if (!lastSeen) continue;
    const list = out.get(row.source) ?? [];
    list.push({ type: row.type, lastSeenAt: lastSeen.toISOString() });
    out.set(row.source, list);
  }
  return out;
}

/**
 * Newest workout per source. `Workout` rows are hard-deleted, so there is no
 * tombstone predicate to apply.
 */
export async function getWorkoutFreshnessBySource(
  userId: string,
  sources: readonly MeasurementSource[],
): Promise<Map<MeasurementSource, string>> {
  const out = new Map<MeasurementSource, string>();
  if (sources.length === 0) return out;

  const grouped = await prisma.workout.groupBy({
    by: ["source"],
    where: { userId, source: { in: [...sources] } },
    _max: { startedAt: true },
  });

  for (const row of grouped) {
    const lastSeen = row._max.startedAt;
    if (!lastSeen) continue;
    out.set(row.source, lastSeen.toISOString());
  }
  return out;
}

/**
 * Per-metric last-value timestamps for one measurement source, sorted
 * alphabetically for a stable wire shape. Used by the Apple Health route, whose
 * transport sits outside the integration envelope.
 */
export async function getSourceFreshness(
  userId: string,
  source: MeasurementSource,
): Promise<MetricFreshnessSample[]> {
  const [measurements, workouts] = await Promise.all([
    getMeasurementFreshnessBySource(userId, [source]),
    getWorkoutFreshnessBySource(userId, [source]),
  ]);
  const entries = measurements.get(source) ?? [];
  const workoutSeenAt = workouts.get(source);
  if (workoutSeenAt) {
    entries.push({
      type: WORKOUT_FRESHNESS_TYPE,
      lastSeenAt: workoutSeenAt,
    });
  }
  return sortByType(entries);
}

/**
 * Compute per-`(integration, type)` last-value timestamps for the sync
 * integrations, keyed by `IntegrationKey`. Two grouped queries (measurements +
 * workouts); a source with no rows simply has no entry.
 */
export async function getSourceMetricFreshness(
  userId: string,
): Promise<Partial<Record<IntegrationKey, MetricFreshnessSample[]>>> {
  const [measurements, workouts] = await Promise.all([
    getMeasurementFreshnessBySource(
      userId,
      Object.values(INTEGRATION_MEASUREMENT_SOURCE),
    ),
    getWorkoutFreshnessBySource(
      userId,
      Object.values(INTEGRATION_WORKOUT_SOURCE),
    ),
  ]);

  const out: Partial<Record<IntegrationKey, MetricFreshnessSample[]>> = {};

  for (const [key, source] of Object.entries(
    INTEGRATION_MEASUREMENT_SOURCE,
  ) as Array<[IntegrationKey, MeasurementSource]>) {
    const entries = measurements.get(source);
    if (entries?.length) out[key] = entries;
  }

  for (const [key, source] of Object.entries(
    INTEGRATION_WORKOUT_SOURCE,
  ) as Array<[IntegrationKey, MeasurementSource]>) {
    const lastSeenAt = workouts.get(source);
    if (!lastSeenAt) continue;
    (out[key] ??= []).push({
      type: WORKOUT_FRESHNESS_TYPE,
      lastSeenAt,
    });
  }

  for (const key of Object.keys(out) as IntegrationKey[]) {
    out[key] = sortByType(out[key]!);
  }
  return out;
}

function sortByType(entries: MetricFreshnessSample[]): MetricFreshnessSample[] {
  return [...entries].sort((a, b) => a.type.localeCompare(b.type));
}
