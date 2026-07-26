/**
 * Daily prune for soft-deleted rows across the sync domains (v1.7.0):
 * `measurements`, `mood_entries`, and `medication_intake_events`.
 *
 * The user-facing DELETE routes on all three domains soft-delete (set
 * `deletedAt`) so the `/api/sync/changes` delta feed can surface deletions
 * as tombstones to paired clients that were offline at delete time. A
 * tombstone only needs to outlive the device's refresh-token lifetime plus
 * a margin: a device offline longer than that has lost its refresh token
 * and re-pairs with a full backfill (not an incremental delta), so it
 * never relies on the tombstone. Past the retention horizon the row is
 * hard-deleted to reclaim storage; the `/api/sync/changes` route emits
 * `cursorExpired` for any cursor that predates the same horizon so a
 * long-offline client re-inits cleanly rather than silently missing the
 * pruned deletion.
 *
 * Retention is keyed to `TOMBSTONE_RETENTION_DAYS`
 * (`NATIVE_REFRESH_TOKEN_DAYS` + margin) so it moves automatically if the
 * refresh-token lifetime changes — the two never drift.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import { purgeInBatches, type PurgeOutcome } from "@/lib/jobs/purge-batch";

const DAY_MS = 86_400_000;

function tombstoneCutoff(now: Date): Date {
  return new Date(now.getTime() - TOMBSTONE_RETENTION_DAYS * DAY_MS);
}

/**
 * Hard-delete soft-deleted measurement rows whose `deletedAt` is older than
 * the retention horizon.
 *
 * Batched. Until v1.33.0 this was one unbounded `deleteMany` over a predicate
 * that no index supported, which meant a backlog large enough to exceed the
 * 60-second `statement_timeout` could never be drained: the statement aborted,
 * the transaction rolled back, and the next night ran the identical statement
 * against the same rows. `measurements` is the densest table in the schema and
 * a bulk source delete can tombstone a six-figure row count in one action, so
 * this is the one most likely to have been stuck. Migration 0277 adds the
 * partial index the predicate needs.
 */
export async function cleanupExpiredMeasurementTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<PurgeOutcome> {
  const cutoff = tombstoneCutoff(now);
  return purgeInBatches({
    findIds: async (take) =>
      (
        await prisma.measurement.findMany({
          where: { deletedAt: { not: null, lt: cutoff } },
          select: { id: true },
          take,
        })
      ).map((row) => row.id),
    deleteIds: async (ids) =>
      (await prisma.measurement.deleteMany({ where: { id: { in: ids } } }))
        .count,
  });
}

/** Hard-delete soft-deleted mood-entry rows past the retention horizon. */
export async function cleanupExpiredMoodTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<PurgeOutcome> {
  const cutoff = tombstoneCutoff(now);
  return purgeInBatches({
    findIds: async (take) =>
      (
        await prisma.moodEntry.findMany({
          where: { deletedAt: { not: null, lt: cutoff } },
          select: { id: true },
          take,
        })
      ).map((row) => row.id),
    deleteIds: async (ids) =>
      (await prisma.moodEntry.deleteMany({ where: { id: { in: ids } } })).count,
  });
}

/**
 * Hard-delete soft-deleted medication-intake-event rows past the retention
 * horizon.
 */
export async function cleanupExpiredIntakeTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<PurgeOutcome> {
  const cutoff = tombstoneCutoff(now);
  return purgeInBatches({
    findIds: async (take) =>
      (
        await prisma.medicationIntakeEvent.findMany({
          where: { deletedAt: { not: null, lt: cutoff } },
          select: { id: true },
          take,
        })
      ).map((row) => row.id),
    deleteIds: async (ids) =>
      (
        await prisma.medicationIntakeEvent.deleteMany({
          where: { id: { in: ids } },
        })
      ).count,
  });
}
