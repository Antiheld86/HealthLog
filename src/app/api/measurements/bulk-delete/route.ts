/**
 * `POST /api/measurements/bulk-delete` — multi-select soft-delete for the
 * measurements management list (v1.15.13).
 *
 * Body:
 *   { ids: string[] }   — 1..200 measurement ids, scoped to the caller.
 *
 * Soft-deletes (tombstones) every owned, not-already-deleted row in one
 * `updateMany` — matching the single-DELETE iOS tombstone contract. A
 * forged / foreign id is a silent no-op (never a 404 existence leak): the
 * mutation `where` pins `userId` so it only ever touches the caller's rows.
 *
 * Response (200):
 *   { deleted: <number of rows tombstoned> }
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import {
  recomputeBucketsForMeasurement,
  collapseToTypeDayKeys,
} from "@/lib/rollups/measurement-rollups";
import type { MeasurementType } from "@/generated/prisma/client";

const MAX_IDS_PER_BATCH = 200;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_IDS_PER_BATCH),
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulkDelete));

async function postBulkDelete(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE. Every row tombstones and `measurements/restore` puts
  // them back, so reconstruction rides the rows themselves rather than the
  // audit details.
  const { user, actor } = await requireRecordAuth("manage", "measurements");

  // v1.37.0 — C1: the bucket keys on the ACTOR, the frozen precedent from
  // `medications/compliance`. A manager burns their own allowance rather than
  // locking the owner out of their own record, and cannot collect a fresh one
  // by switching records.
  const rl = await checkRateLimit(
    `measurements:bulk-delete:${actor.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk deletions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 256 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = bulkDeleteSchema.safeParse(rawBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "measurement.bulk-delete.invalid",
    });
  }

  const { ids } = parsed.data;
  const now = new Date();

  // Read the soon-to-be-tombstoned rows first so we know which
  // `(type, day)` buckets need a rollup recompute and which types need
  // a status-insight cache drop. Ownership-scoped + `deletedAt: null` so
  // a forged / foreign / already-tombstoned id is excluded here exactly
  // as it is from the mutation below — no existence leak.
  const affected = await prisma.measurement.findMany({
    where: { id: { in: ids }, userId: user.id, deletedAt: null },
    select: { type: true, measuredAt: true },
  });

  // Soft-delete (tombstone) in one statement. The `where` pins `userId`
  // so a forged id for another user is silently a no-op; `deletedAt: null`
  // keeps the count honest (an already-tombstoned id doesn't re-count).
  const { count } = await prisma.measurement.updateMany({
    where: { id: { in: ids }, userId: user.id, deletedAt: null },
    data: { deletedAt: now, syncVersion: { increment: 1 } },
  });

  await auditLog("measurement.delete.bulk", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { count },
  });

  annotate({
    action: { name: "measurement.delete.bulk" },
    meta: { count },
  });

  if (count > 0) {
    // v1.4.34 IW-G — bust per-user analytics + achievements + workouts
    // caches so subsequent reads reflect the deletions. Interactive
    // multi-select delete from the management list — hard-evict so the
    // SWR readers don't serve the pre-delete body.
    invalidateUserMeasurements(user.id, { evict: true });

    // Collapse the deleted rows to the unique `(type, day)` set BEFORE
    // recomputing so a 200-row delete spanning one day fires ~1 recompute
    // per type, not 200 (mirrors the batch-insert path). Best-effort — a
    // populator hiccup never fails the user's delete.
    const keys = collapseToTypeDayKeys(
      affected.map((row) => ({
        type: row.type as MeasurementType,
        measuredAt: row.measuredAt,
      })),
    );
    try {
      for (const k of keys) {
        await recomputeBucketsForMeasurement(user.id, k.type, k.measuredAt);
      }
    } catch (err) {
      console.warn("[measurements] bulk-delete rollup recompute failed", err);
    }

    // v1.8.0 — drop the cached per-metric assessment rows the deletion
    // dirties so the next mount / nightly warm pass regenerates against
    // the reduced history. Fire-and-forget: never blocks the delete.
    const affectedTypes = Array.from(new Set(keys.map((k) => k.type)));
    if (affectedTypes.length > 0) {
      invalidateStatusInsightsForTypes(user.id, affectedTypes).catch((err) => {
        console.warn(
          "[measurements] bulk-delete status-insight invalidate failed",
          err,
        );
      });
    }
  }

  return apiSuccess({ deleted: count });
}
