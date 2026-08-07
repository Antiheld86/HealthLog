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
import { serialiseCustomMetric } from "@/lib/custom-metrics/custom-metric-store";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { updateCustomMetricSchema } from "@/lib/validations/custom-metrics";

/**
 * v1.25.5 — single custom-metric resource (`/api/custom-metrics/{id}`).
 *
 * GET returns the metric definition. PATCH applies a partial edit (`data` built
 * field-by-field; an explicit `null` clears `targetLow` / `targetHigh` /
 * `decimals` / `description`, an omitted key leaves it untouched). DELETE
 * soft-deletes by stamping `deletedAt`. Cross-user rows surface as 404
 * (existence sealed).
 */

type RouteParams = { params: Promise<{ id: string }> };

/** Resolve an effective bound: the parsed value when present, else the stored. */
function effectiveBound(
  parsed: number | null | undefined,
  stored: number | null,
): number | null {
  return parsed !== undefined ? parsed : stored;
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "measurements");
    const { id } = await params;

    const row = await prisma.customMetric.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row || row.userId !== user.id) {
      return apiError("Custom metric not found", 404);
    }

    annotate({
      action: { name: "custom-metric.metric.get" },
      meta: { customMetricId: id },
    });

    return apiSuccess(serialiseCustomMetric(row));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const existing = await prisma.customMetric.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Custom metric not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = updateCustomMetricSchema.safeParse(body);
    if (!parsed.success) {
      annotate({
        action: { name: "custom-metric.metric.update.validation-failed" },
        meta: { issue_count: parsed.error.issues.length, customMetricId: id },
      });
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "custom-metric.metric.update.validation-failed",
            details: JSON.stringify({
              issues: auditIssues,
              customMetricId: id,
            }),
          },
        })
        .catch(() => {
          /* swallow — the 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422);
    }

    const d = parsed.data;

    // A rename must not collide with another of the caller's LIVE metrics.
    if (d.name !== undefined && d.name !== existing.name) {
      const clash = await prisma.customMetric.findFirst({
        where: { userId: user.id, name: d.name, deletedAt: null },
        select: { id: true },
      });
      if (clash) {
        return apiError("A custom metric with this name already exists", 409);
      }
    }

    // Build `data` field-by-field. `undefined` → leave the column untouched;
    // an explicit `null` on a target bound / decimals / description clears it.
    const data: Record<string, unknown> = {};
    if (d.name !== undefined) data.name = d.name;
    if (d.unit !== undefined) data.unit = d.unit;
    if (d.targetLow !== undefined) data.targetLow = d.targetLow;
    if (d.targetHigh !== undefined) data.targetHigh = d.targetHigh;
    if (d.decimals !== undefined) data.decimals = d.decimals;
    if (d.description !== undefined) data.description = d.description;
    if (d.correlationEnabled !== undefined) {
      data.correlationEnabled = d.correlationEnabled;
    }

    // Inverted-range guard for a PARTIAL bound update. The schema refine only
    // fires when both bounds arrive together; moving a single bound past the
    // row's existing other bound would otherwise persist an inverted window.
    const low = effectiveBound(d.targetLow, existing.targetLow);
    const high = effectiveBound(d.targetHigh, existing.targetHigh);
    if (low !== null && high !== null && low > high) {
      return apiError("targetLow must not exceed targetHigh", 422);
    }

    const updated = await prisma.customMetric.update({ where: { id }, data });

    await auditLog("customMetric.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { customMetricId: id },
    });

    annotate({
      action: { name: "custom-metric.metric.update" },
      meta: { customMetricId: id },
    });
    invalidateUserCorrelationPatterns(user.id);

    return apiSuccess(serialiseCustomMetric(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const existing = await prisma.customMetric.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Custom metric not found", 404);
    }

    // Soft-delete: stamp `deletedAt`. Every read filters `deletedAt: null`, so
    // the metric is invisible from here on; its logged values are retained and
    // a re-create under the same name revives the row (see POST). A re-delete
    // is idempotent (the find above already filtered it out).
    await prisma.customMetric.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await auditLog("customMetric.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { customMetricId: id },
    });

    annotate({
      action: { name: "custom-metric.metric.delete" },
      meta: { customMetricId: id },
    });
    invalidateUserCorrelationPatterns(user.id);

    return apiSuccess({ deleted: true });
  },
);
