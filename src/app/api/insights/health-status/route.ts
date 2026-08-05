/**
 * v1.25 — health-status / baseline-drift read.
 *
 *   GET /api/insights/health-status
 *
 * Surfaces what is drifting from the user's own normal, drawn off two existing
 * read-only engines — the personal-band deviations from the coincident-
 * deviation flag (`coincident-deviation.ts`) and the dated, sustained level
 * shifts from the changepoint detector (`changepoint.ts`). Pure compute over
 * the rollup tier: no provider call, no fabricated value, never a diagnosis.
 *
 * Mirrors `/api/insights/derived`: `apiHandler` wrapper, `requireAuth`, the
 * `insights` module gate, the shared analytics-read budget. `userId` is always
 * narrowed from the session. The labels are mapped client-side from the
 * MeasurementType, so the wire carries the type tokens only.
 */
import { apiError, apiSuccess } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { loadBaselineProfile } from "@/lib/insights/derived";
import { computeCoincidentDeviation } from "@/lib/insights/derived/coincident-deviation";
import { buildChangepointSignals } from "@/lib/insights/derived/changepoint";
import { summariseHealthStatus } from "@/lib/insights/health-status";

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

  const now = new Date();
  const profile = await loadBaselineProfile(prisma, user.id);

  const coincident = await computeCoincidentDeviation(user.id, profile, {
    tz: user.timezone,
    now,
  });
  const shifts = await buildChangepointSignals(user.id, now);

  const vitals = coincident.status === "ok" ? coincident.value.vitals : [];
  const summary = summariseHealthStatus(vitals, shifts);

  annotate({
    action: { name: "insights.health-status.read" },
    meta: {
      deviations: summary.deviations.length,
      shifts: summary.shifts.length,
    },
  });

  return apiSuccess({
    present: summary.present,
    deviations: summary.deviations,
    shifts: summary.shifts,
    generatedAt: now.toISOString(),
  });
});
