/**
 * v1.8.7.1 — on-demand full assessment warm.
 *
 * `POST /api/insights/pregenerate` enqueues a forced full warm of every
 * AI assessment for the calling user — the comprehensive insight (daily
 * briefing), the seven specialised `*-status` cards, and every
 * data-bearing generic `metric:<ID>` assessment — for the user's active
 * locale. The heavy generation runs on the worker (the
 * `insight-pregenerate` queue) so this route returns immediately; the
 * cards then fill via the existing read-only stale-while-revalidate GETs
 * without the user waiting on a provider round-trip.
 *
 * The forced path bypasses the nightly cron's per-user 20 h budget (so a
 * user can warm on demand the moment they land on the page), so this
 * route carries its own short anti-spam bucket — one warm per
 * `WARM_WINDOW_MS` per user. Empty metrics never reach the provider (the
 * worker filters to data-bearing types) and the comprehensive generator
 * no-ops without a configured provider, so a spam-free call on a
 * provider-less account costs one cheap chain-resolve and no LLM call.
 *
 * `userId` is always narrowed from the session / Bearer — never a body
 * field. Both web and the iOS client can call it; they read the same
 * cached routes afterward.
 *
 * The warm covers two AI capabilities: `briefing` (the comprehensive
 * insight) and `statusText` (the assessment cards). It returns no model
 * output, so it never refuses: with neither capability available it answers
 * 200 `{ queued: false }` and enqueues nothing; with one available it
 * enqueues, and the worker checks each half before it builds anything. The
 * `ai` block says which half can run.
 */
import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { normalizeLocale } from "@/lib/insights/status-shared";
import { enqueueForceWarm } from "@/lib/jobs/insight-pregenerate-shared";

export const dynamic = "force-dynamic";

/** Anti-spam window — one forced warm per user per 3 minutes. */
const WARM_WINDOW_MS = 3 * 60 * 1000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const userId = user.id;
  const [briefing, statusText] = await Promise.all([
    getAiCapability("briefing"),
    getAiCapability("statusText"),
  ]);
  const ai = { briefing, statusText };

  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
  });
  // Carry the reader's ACTUAL locale into the warm payload. The former
  // `resolved === "en" ? "en" : "de"` sent every fr/es/it/pl account down the
  // German warm, so the whole warmed cache family was in the wrong language.
  const locale = normalizeLocale(resolved);

  // Nothing this warm covers can run: enqueue nothing, spend no bucket.
  if (!briefing.available && !statusText.available) {
    annotate({
      action: { name: "insights.pregenerate.skipped" },
      meta: {
        locale,
        briefing_reason: briefing.reason,
        status_reason: statusText.reason,
      },
    });
    return apiSuccess({ queued: false, locale, ai });
  }

  // Short per-user bucket so the bypassed nightly budget can't be abused
  // into a provider-cost amplifier by a tight POST loop. A blocked call
  // is harmless — the caches are already being warmed by the prior call.
  const rl = await checkRateLimit(`insights-warm:${userId}`, 1, WARM_WINDOW_MS);
  if (!rl.allowed) {
    return apiError("A warm is already in progress. Try again shortly.", 429);
  }

  await enqueueForceWarm({ userId, locale });

  annotate({
    action: { name: "insights.pregenerate.requested" },
    meta: { locale },
  });

  // The work runs on the worker; report that it was accepted, not that it
  // is done. The client polls the read-only status GETs for the text.
  return apiSuccess({ queued: true, locale, ai });
});
