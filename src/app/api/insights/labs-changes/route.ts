/**
 * v1.25 — "what changed since your last panel" read.
 *
 *   GET /api/insights/labs-changes
 *
 * Groups the user's live numeric lab results by panel date, pairs the two
 * most-recent panels, and reports the per-analyte delta + reference-band
 * standing (`summariseLabChanges`). Absent when there are fewer than two
 * panels, no analyte is shared, or the newest panel is older than the
 * recency window — the card's "since your last panel" wording is a claim
 * about recent news, and it stops being made rather than being made about a
 * years-old draw. Neutral framing only — a delta is not a diagnosis.
 *
 * Mirrors `/api/insights/derived`: `apiHandler`, `requireAuth`, the `insights`
 * module gate, the shared analytics-read budget. `userId` is narrowed from the
 * session; soft-deleted rows (`deletedAt`) are filtered out.
 */
import { apiError, apiSuccess } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { summariseLabChanges } from "@/lib/insights/labs-changes";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");

  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;

  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  const rows = await prisma.labResult.findMany({
    where: { userId: user.id, deletedAt: null, value: { not: null } },
    select: {
      analyte: true,
      unit: true,
      value: true,
      referenceLow: true,
      referenceHigh: true,
      takenAt: true,
    },
    orderBy: { takenAt: "desc" },
  });

  const summary = summariseLabChanges(
    rows.map((r) => ({
      analyte: r.analyte,
      unit: r.unit,
      value: r.value as number,
      referenceLow: r.referenceLow,
      referenceHigh: r.referenceHigh,
      takenAt: r.takenAt,
    })),
  );

  annotate({
    action: { name: "insights.labs-changes.read" },
    meta: {
      present: summary.present,
      changes: summary.changes.length,
      // Distinguishes "no comparable panels" from "the comparison aged out",
      // so an absent card is diagnosable without reaching for the database.
      lab_rows: rows.length,
    },
  });

  return apiSuccess({ ...summary, generatedAt: new Date().toISOString() });
});
