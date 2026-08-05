/**
 * Per-biomarker assessment route.
 *
 * `GET /api/insights/biomarker-assessment?biomarkerId=<id>` serves the
 * data-driven assessment for one user-scoped biomarker. The shape is
 * byte-identical to `/api/insights/metric-status` so `InsightStatusCard`
 * consumes it unchanged.
 *
 * Read-only by construction: a cache miss enqueues an out-of-band
 * generation (via `resolveReadOnlyStatusMiss` inside the generator) and
 * serves the last-good text (stale-while-revalidate), never blocking on the
 * provider. The generator regenerates ONLY when the latest reading
 * fingerprint changes, so an idle marker re-stamps cached text without an
 * LLM round-trip.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { generateBiomarkerStatus } from "@/lib/insights/biomarker-status";
import { resolveMetricStatusLocale } from "@/lib/insights/metric-status";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  biomarkerId: z.string().min(1).max(64),
});

export const GET = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE-level read: a generated assessment over the whole
  // record, which is not a section a scoped grant can name. The miss behind it
  // enqueues nothing while a delegate is holding the request.
  const { user } = await requireRecordAuth("manage", "record");
  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;
  await requireAssistantSurface("insightStatus");

  const parsed = querySchema.safeParse({
    biomarkerId: request.nextUrl.searchParams.get("biomarkerId"),
  });
  if (!parsed.success) {
    annotate({
      action: { name: "insights.biomarker-status.invalid" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const localeParam = request.nextUrl.searchParams.get("locale");
  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: localeParam,
  });
  const locale = resolveMetricStatusLocale(resolved);

  const result = await generateBiomarkerStatus({
    biomarkerId: parsed.data.biomarkerId,
    userId: user.id,
    locale,
    force: false,
    readOnly: true,
  });

  annotate({
    action: { name: "insights.biomarker-status" },
    meta: { biomarkerId: parsed.data.biomarkerId },
  });

  return apiSuccess(result);
});
