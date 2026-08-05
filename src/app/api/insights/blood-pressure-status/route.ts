import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import {
  generateBloodPressureStatusForUser,
  resolveBloodPressureStatusLocale,
} from "@/lib/insights/blood-pressure-status";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { requireModuleEnabled } from "@/lib/modules/gate";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE-level read: a generated assessment over the whole
  // record, which is not a section a scoped grant can name. The miss behind it
  // enqueues nothing while a delegate is holding the request.
  const { user } = await requireRecordAuth("manage", "record");
  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;
  await requireAssistantSurface("insightStatus");

  const localeParam = request.nextUrl.searchParams.get("locale");
  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: localeParam,
  });
  const locale = resolveBloodPressureStatusLocale(resolved);

  // v1.8.3 — read-only: serve the cache, enqueue generation out of band on
  // a miss. The GET never awaits the provider, so opening /insights/<metric>
  // can no longer pin the main thread behind a cold LLM round-trip.
  const result = await generateBloodPressureStatusForUser(user.id, {
    locale,
    force: false,
    readOnly: true,
  });

  annotate({ action: { name: "insights.blood-pressure-status" } });

  return apiSuccess(result);
});
