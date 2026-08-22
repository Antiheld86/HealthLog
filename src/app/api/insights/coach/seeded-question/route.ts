/**
 * v1.21.2 (A3) — pre-seeded relevance opener for the unscoped Coach.
 *
 * `GET /api/insights/coach/seeded-question` resolves today's single most
 * notable derived wellness signal (readiness / recovery shift, the same
 * confidence-gated detector the daily briefing uses) into a tappable
 * suggested opener for the Coach's blank new-chat hero. When no signal
 * crosses the gate the route returns `{ signal: null }` and the hero
 * keeps its neutral greeting — never a fabricated opener.
 *
 * The signal is selected SERVER-SIDE; the client renders the resolved DTO
 * and never recomputes it (server-authoritative parity). It IS registered in
 * the OpenAPI contract. This comment said the opposite until the route was
 * published — it shipped as a same-origin web surface and the sentence was
 * never revisited. A comment that contradicts the registry is worse than no
 * comment, because the next reader believes it instead of checking.
 *
 * Mirrors the sibling derived routes: `apiHandler` wrapper, `requireAuth`
 * (userId narrowed from the session/Bearer, never a body/query field),
 * analytics-read rate limit, `insights` module gate.
 */
import { apiError, apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { prisma } from "@/lib/db";
import { loadBaselineProfile } from "@/lib/insights/derived";
import { detectDerivedBriefingSignals } from "@/lib/insights/derived-briefing";
import { resolveCoachAmbientSuggestionsEnabled } from "@/lib/validations/notification-prefs";

export const dynamic = "force-dynamic";

/** Resolved opener the hero renders, or null when nothing notable. */
export interface CoachSeededQuestionDTO {
  /**
   * The notable signal driving the opener, or null when nothing crossed
   * the briefing detector's confidence + notability gate.
   */
  signal: {
    /** Sentinel id (`readiness` / `recovery`) the client keys i18n on. */
    sourceMetric: string;
    /** Latest 0–100 score. */
    score: number;
    /** Band — `yellow` / `red` (green never surfaces as notable). */
    band: string;
  } | null;
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;

  // The opener feeds the Coach hero, so it gates on the Coach assistant
  // matrix: with the Coach off there is no hero to seed.
  await requireAssistantSurface("coach");

  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  // Server-authoritative ambient-suggestions opt-out: when the user turns
  // proactive suggestions off the hero must not seed an opener, so the route
  // skips the detector work and returns the neutral `{ signal: null }` shape.
  const prefsRow = await prisma.user.findUnique({
    where: { id: user.id },
    select: { notificationPrefs: true },
  });
  if (
    !resolveCoachAmbientSuggestionsEnabled(prefsRow?.notificationPrefs ?? null)
  ) {
    annotate({
      action: { name: "coach.seeded-question.resolve" },
      meta: { has_signal: false, source_metric: "none", band: "none" },
    });
    return apiSuccess({ signal: null } satisfies CoachSeededQuestionDTO);
  }

  // Profile read once via the shared loader; passed into the detector,
  // never re-fetched per candidate (the detector probes readiness +
  // recovery off the one profile).
  const profile = await loadBaselineProfile(prisma, user.id);
  const detected = await detectDerivedBriefingSignals(user.id, profile);

  // The detector returns 1–2 signals in priority order; the opener anchors
  // on the single most notable one (the head).
  const top = detected?.signals[0] ?? null;
  const signal: CoachSeededQuestionDTO["signal"] = top
    ? { sourceMetric: top.sourceMetric, score: top.score, band: top.band }
    : null;

  annotate({
    action: { name: "coach.seeded-question.resolve" },
    meta: {
      has_signal: signal !== null,
      source_metric: signal?.sourceMetric ?? "none",
      band: signal?.band ?? "none",
    },
  });

  return apiSuccess({ signal } satisfies CoachSeededQuestionDTO);
});
