/**
 * Shared post-mutation tail for every surface that creates, updates,
 * deletes, or restores `Measurement` rows.
 *
 * Two consumers hang off every measurement write and both were being
 * re-remembered by hand at each write surface (the documented two-ended
 * failure class):
 *
 *   1. the `(type, day)` rollup buckets the mutation dirtied — recomputed
 *      inline (DAY) + enqueued (WEEK/MONTH/YEAR) via
 *      `recomputeBucketsForMeasurement`. The recompute handles deletions
 *      inherently: a day left empty drops its rollup row.
 *   2. the cached per-metric status assessments — re-warmed via
 *      `invalidateStatusInsightsForTypes` (fire-and-forget).
 *
 * Both legs are best-effort: a populator hiccup never fails the user's
 * mutation. Callers collect the affected `(type, measuredAt)` pairs
 * (for deletes: BEFORE the destructive statement, while the rows are
 * still readable) and hand them here.
 */
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/status-invalidation";
import type { MeasurementType } from "@/generated/prisma/client";

export async function afterMeasurementMutation(
  userId: string,
  rows: Array<{ type: MeasurementType; measuredAt: Date }>,
  /** Log prefix identifying the calling surface in the warn lines. */
  label = "measurements",
): Promise<void> {
  if (rows.length === 0) return;

  // Collapse to the distinct `(type, day)` set BEFORE recomputing so a
  // 500-row batch fires at most one DAY recompute per touched bucket.
  const keys = collapseToTypeDayKeys(rows);
  try {
    for (const k of keys) {
      await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
    }
  } catch (err) {
    console.warn(`[${label}] rollup recompute failed`, err);
  }

  // Status-insight re-warm is fire-and-forget — it must run even when
  // the rollup leg above failed, so the two legs never gate each other.
  const types = Array.from(new Set(keys.map((k) => k.type)));
  if (types.length > 0) {
    invalidateStatusInsightsForTypes(userId, types).catch((err) => {
      console.warn(`[${label}] status-insight invalidate failed`, err);
    });
  }
}
