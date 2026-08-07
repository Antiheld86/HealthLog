/**
 * v1.11.0 W3 — period-narrative read route (Pillar P1).
 *
 * `GET /api/insights/narrative?period=week|month` serves the latest generated
 * period summary for the calling user. Read-only by construction (the v1.8.3
 * freeze posture): it NEVER blocks on the provider. It returns the last good
 * narrative immediately (stale-while-revalidate) and, when the row is missing
 * or stale and a provider is configured, fire-and-forget enqueues a warm so
 * the next read reflects the latest period.
 *
 * `userId` is narrowed from the session/Bearer (never a query field); an
 * unknown `period` 422s via the closed enum.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { locales, defaultLocale, type Locale } from "@/lib/i18n/config";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { readPeriodNarrative } from "@/lib/insights/narrative/period-narrative-generate";
import {
  PERIOD_DAYS,
  type NarrativePeriod,
} from "@/lib/insights/narrative/period-narrative";
import { enqueueNarrativeWarm } from "@/lib/jobs/period-narrative-shared";
import { delegatedGenerationSuppressed } from "@/lib/sharing/delegated-generation";

export const dynamic = "force-dynamic";

const NARRATIVE_PERIODS = Object.keys(PERIOD_DAYS) as [string, ...string[]];

const narrativeQuerySchema = z.object({
  period: z.enum(NARRATIVE_PERIODS),
});

/** A narrative read this recently is considered fresh; no warm is enqueued. */
const NARRATIVE_FRESH_MS = 20 * 60 * 60 * 1000;

/**
 * The narrative row is keyed `(user, period, locale)` across the full UI
 * locale union, so the resolved locale is carried through as-is.
 *
 * This used to be `locale === "en" ? "en" : "de"` — which sent every French,
 * Spanish, Italian and Polish reader to the German narrative row and the
 * German prompt behind it. `resolveServerLocale` already returns a validated
 * `Locale`; an unknown value falls back to the app default (`en`) there.
 */
function narrowLocale(locale: Locale): Locale {
  return locales.includes(locale) ? locale : defaultLocale;
}

export const GET = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE-level read: a generated assessment over the whole
  // record, which is not a section a scoped grant can name. The miss behind it
  // enqueues nothing while a delegate is holding the request.
  const { user } = await requireRecordAuth("manage", "record");
  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;
  await requireAssistantSurface("insightStatus");

  const parsed = narrativeQuerySchema.safeParse({
    period: request.nextUrl.searchParams.get("period"),
  });
  if (!parsed.success) {
    annotate({
      action: { name: "insights.narrative.invalid-period" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }
  const period = parsed.data.period as NarrativePeriod;

  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: request.nextUrl.searchParams.get("locale"),
  });
  const locale = narrowLocale(resolved);

  const existing = await readPeriodNarrative(user.id, period, locale);
  const isFresh =
    existing !== null &&
    Date.now() - new Date(existing.updatedAt).getTime() < NARRATIVE_FRESH_MS;

  // Read-only: never block on the provider. Warm out of band whenever the row
  // is stale / missing. The generator produces AI prose when a provider is
  // configured and a deterministic, non-causal fallback otherwise, so even a
  // provider-less account (incl. the no-key demo) gets a non-empty
  // retrospective on the next read. The enqueue's singletonKey + the 20 h
  // freshness window bound this to at most one warm per period per ~day.
  //
  // v1.37.0 — except on a delegated request. This route warms unconditionally
  // rather than on a miss, so without the check a manager's first navigation
  // here is an egress of the owner's record that the owner did not ask for.
  // The stale row is still served; only the warm is withheld.
  let revalidating = false;
  const generationSuppressed = delegatedGenerationSuppressed();
  if (!isFresh && !generationSuppressed) {
    void enqueueNarrativeWarm({ userId: user.id, period, locale });
    revalidating = true;
  }

  annotate({
    action: { name: "insights.narrative" },
    meta: {
      period,
      has_narrative: existing !== null,
      revalidating,
      generation_suppressed: generationSuppressed,
    },
  });

  return apiSuccess({
    period,
    locale,
    narrative: existing
      ? {
          text: existing.text,
          provenance: existing.provenance,
          updatedAt: existing.updatedAt,
        }
      : null,
    revalidating,
  });
});
