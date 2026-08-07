import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import {
  generateMoodStatusForUser,
  resolveMoodStatusLocale,
} from "@/lib/insights/mood-status";
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

  // Per-domain gate: the mood module must be enabled for this account
  // before the mood AI-status surface is served (mirrors the cycle gate).
  const gate = await requireModuleEnabled(user.id, "mood");
  if (!gate.enabled) return gate.response;

  await requireAssistantSurface("insightStatus");

  const localeParam = request.nextUrl.searchParams.get("locale");
  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: localeParam,
  });
  const locale = resolveMoodStatusLocale(resolved);

  // v1.8.3 — read-only: serve the cache, enqueue generation out of band on
  // a miss. The GET never awaits the provider, so opening /insights/<metric>
  // can no longer pin the main thread behind a cold LLM round-trip.
  const result = await generateMoodStatusForUser(user.id, {
    locale,
    force: false,
    readOnly: true,
  });

  annotate({ action: { name: "insights.mood-status" } });

  return apiSuccess(result);
});
