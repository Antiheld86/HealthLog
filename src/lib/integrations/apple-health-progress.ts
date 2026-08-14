/**
 * First-run Apple Health sync progress (issue #778).
 *
 * The iOS app drives the HealthKit backfill; the server only ever sees the
 * batches that actually arrive. During a first run nothing on the web said
 * how far that had come, so a backfill that was quietly working looked
 * broken. This module computes the figures the server genuinely holds — how
 * many rows carry the `APPLE_HEALTH` source and how far back in time they
 * reach — and nothing more: the phone's throttle state, its remaining queue,
 * and any ETA live on the device and are deliberately not invented here.
 *
 * Both the live batch ingest and the one-shot export.zip import write
 * `source = APPLE_HEALTH`, so the count is "Apple Health records in
 * HealthLog", not "records from one specific pipe" — which is the number a
 * user watching a first run actually wants to see grow.
 */
import { prisma } from "@/lib/db";

export interface AppleHealthSyncProgress {
  /** Measurement + workout rows carrying the `APPLE_HEALTH` source. */
  recordsAccepted: number;
  /**
   * Earliest instant reached (`measuredAt` for measurements, `startedAt` for
   * workouts), as an ISO string; null when nothing has arrived.
   */
  oldestMeasuredAt: string | null;
}

/**
 * Two grouped aggregates (count + MIN), mirroring the freshness reads in
 * `./metric-freshness.ts` which cover the same two tables for the same
 * reason: workouts are Apple Health data too, but never `Measurement` rows.
 */
export async function getAppleHealthSyncProgress(
  userId: string,
): Promise<AppleHealthSyncProgress> {
  const [measurements, workouts] = await Promise.all([
    prisma.measurement.aggregate({
      where: { userId, deletedAt: null, source: "APPLE_HEALTH" },
      _count: { _all: true },
      _min: { measuredAt: true },
    }),
    // `Workout` rows are hard-deleted, so there is no tombstone predicate.
    prisma.workout.aggregate({
      where: { userId, source: "APPLE_HEALTH" },
      _count: { _all: true },
      _min: { startedAt: true },
    }),
  ]);

  const minima = [measurements._min.measuredAt, workouts._min.startedAt].filter(
    (d): d is Date => d instanceof Date,
  );
  const oldest =
    minima.length > 0
      ? new Date(Math.min(...minima.map((d) => d.getTime())))
      : null;

  return {
    recordsAccepted: measurements._count._all + workouts._count._all,
    oldestMeasuredAt: oldest?.toISOString() ?? null,
  };
}
