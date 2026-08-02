import { NextRequest } from "next/server";

import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserCorrelationPatterns } from "@/lib/cache/invalidate";
import { serialiseCustomMetricEntry } from "@/lib/custom-metrics/custom-metric-store";
import { prisma } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import {
  createCustomMetricEntrySchema,
  listCustomMetricEntriesSchema,
} from "@/lib/validations/custom-metrics";

/**
 * v1.25.5 — logged values for one custom metric
 * (`/api/custom-metrics/{id}/entries`).
 *
 * GET lists the metric's values with offset pagination (the chart + history
 * feed). POST records a value, snapshotting the metric's current `unit` onto
 * the entry at write time (historical truth). `userId` is always narrowed from
 * the session and the parent metric is verified owner-scoped (a forged / foreign
 * id is a 404) before any value is read or written.
 */

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read");
    const { id } = await params;

    const metric = await prisma.customMetric.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!metric) {
      return apiError("Custom metric not found", 404);
    }

    const query = Object.fromEntries(request.nextUrl.searchParams);
    const parsed = listCustomMetricEntriesSchema.safeParse(query);
    if (!parsed.success) {
      annotate({
        action: { name: "custom-metric.entry.list.validation-failed" },
        meta: { issue_count: parsed.error.issues.length },
      });
      return returnAllZodIssues(parsed.error, 422);
    }

    const { limit, offset, sortDir } = parsed.data;
    const where = { userId: user.id, customMetricId: id };

    const [rows, total] = await Promise.all([
      prisma.customMetricEntry.findMany({
        where,
        orderBy: { measuredAt: sortDir },
        take: limit,
        skip: offset,
      }),
      prisma.customMetricEntry.count({ where }),
    ]);

    annotate({
      action: { name: "custom-metric.entry.list" },
      meta: { customMetricId: id, total, limit, offset },
    });

    return apiSuccess({
      entries: rows.map(serialiseCustomMetricEntry),
      meta: { total, limit, offset },
    });
  },
);

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postCustomMetricEntry),
);

async function postCustomMetricEntry(
  request: NextRequest,
  { params }: RouteParams,
) {
  const { user } = await requireAuth();
  const { id } = await params;

  const metric = await prisma.customMetric.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true, unit: true },
  });
  if (!metric) {
    return apiError("Custom metric not found", 404);
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createCustomMetricEntrySchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "custom-metric.entry.create.validation-failed" },
      meta: { issue_count: parsed.error.issues.length, customMetricId: id },
    });
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "custom-metric.entry.create.validation-failed",
          details: JSON.stringify({ issues: auditIssues, customMetricId: id }),
        },
      })
      .catch(() => {
        /* swallow — the 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { value, measuredAt, note } = parsed.data;

  // Field-by-field assignment — never spread `parsed.data`. The metric's
  // current unit is snapshotted onto the entry as historical truth.
  const created = await prisma.customMetricEntry.create({
    data: {
      userId: user.id,
      customMetricId: metric.id,
      value,
      unit: metric.unit,
      measuredAt,
      note: note ?? null,
    },
  });

  await auditLog("customMetricEntry.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { customMetricId: id, entryId: created.id },
  });

  annotate({
    action: { name: "custom-metric.entry.create" },
    meta: { customMetricId: id, entryId: created.id },
  });
  invalidateUserCorrelationPatterns(user.id);

  return apiSuccess(serialiseCustomMetricEntry(created), 201);
}
