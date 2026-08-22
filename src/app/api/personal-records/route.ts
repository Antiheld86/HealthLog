/**
 * GET /api/personal-records
 *
 * v1.4.25 W8d — schema-only release of the PersonalRecord feature.
 * The detection worker that actually populates rows lands in a later
 * release (v1.4.26 or v1.5 — TBD). This route exists today so the
 * v1.5 iOS-Swift app can build its query path against a stable
 * contract from day one.
 *
 * Query params (validated against `listPersonalRecordsSchema`; a bad value
 * is a 422, not a shrug):
 *   - metricType: optional MeasurementType filter (e.g. ?metricType=VO2_MAX)
 *   - limit: optional pagination cap (default 100, max 500)
 *
 * Both were parsed defensively until this release — an unknown `metricType`
 * was dropped and a garbage `limit` reverted to the default. That read as
 * robustness and behaved as silence, and in one direction it was worse than
 * silence: dropping the filter WIDENS the read to every metric, so a typo
 * returned more rows than the caller asked for and nothing said so. The 500
 * ceiling refuses rather than clamps, for the same reason.
 *
 * Response envelope (matches the project-wide `apiSuccess` contract):
 *   { data: PersonalRecord[], error: null }
 */
import { prisma } from "@/lib/db";
import type { NextRequest } from "next/server";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { listPersonalRecordsSchema } from "@/lib/validations/measurement";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");
  annotate({ action: { name: "personalRecords.list" } });

  const parsed = listPersonalRecordsSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    annotate({
      action: { name: "personalRecords.list" },
      meta: {
        outcome: "validation_failed",
        issue_count: parsed.error.issues.length,
      },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "personal_records.invalid_query",
    });
  }
  const { metricType, limit } = parsed.data;

  const records = await prisma.personalRecord.findMany({
    where: {
      userId: user.id,
      ...(metricType ? { metricType } : {}),
    },
    orderBy: { achievedAt: "desc" },
    take: limit,
  });

  return apiSuccess(records);
});
