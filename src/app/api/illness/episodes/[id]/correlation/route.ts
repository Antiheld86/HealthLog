/**
 * `GET /api/illness/episodes/{id}/correlation` — the retrospective correlation
 * findings for one episode: the pre-onset anomaly scan ("how did it announce
 * itself"), the nadir / what-dropped, and the recovery-gap (physiological
 * return-to-baseline vs the felt-better marker).
 *
 * Server-authoritative + coverage-gated: the response is a `Derived<T>` flat
 * wire shape (`status: "ok" | "insufficient"`). When the signal is thin the
 * engine returns `insufficient` with coverage + a reason — the surface renders
 * "we're still learning", never a fabricated number. The findings are derived
 * from the user's OWN baseline (median ± MAD), never a population constant, and
 * the baseline window is contamination-guarded (ends before the pre-onset
 * lookback). Retrospective ONLY — never a predictor or diagnoser. Born-gated +
 * owner-scoped.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import { computeEpisodeCorrelation } from "@/lib/illness/correlation-read";
import { notifyIllnessRedFlag } from "@/lib/illness/red-flag-notify";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const episode = await prisma.illnessEpisode.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        onsetAt: true,
        resolvedAt: true,
        lifecycle: true,
      },
    });
    if (!episode || episode.userId !== user.id || episode.deletedAt !== null) {
      return apiError("Episode not found", 404);
    }

    const tz = user.timezone ?? DEFAULT_TIMEZONE;
    const derived = await computeEpisodeCorrelation(
      user.id,
      {
        id: episode.id,
        onsetAt: episode.onsetAt,
        resolvedAt: episode.resolvedAt,
        lifecycle: episode.lifecycle,
      },
      tz,
    );

    annotate({
      action: {
        name: "illness.correlation.read",
        entity_type: "illness_episode",
        entity_id: id,
      },
      meta: {
        status: derived.status,
        recovery_gap_days:
          derived.status === "ok" ? derived.value.recoveryGapDays : null,
        red_flags: derived.status === "ok" ? derived.value.redFlags.length : 0,
      },
    });

    // v1.18.4 — bridge the red-flag escalation to an urgent push. Owner-scoped
    // (the episode is already confirmed to belong to `user.id`) + module-gated
    // (the illness gate above). Awaited but internally de-duped + no-throw, so a
    // re-read never re-fires and a notification hiccup can't fail the read.
    if (derived.status === "ok" && derived.value.redFlags.length > 0) {
      await notifyIllnessRedFlag({
        userId: user.id,
        episodeId: id,
        redFlags: derived.value.redFlags,
      });
    }

    return apiSuccess({
      episodeId: id,
      status: derived.status,
      value: derived.status === "ok" ? derived.value : null,
      coverage: derived.coverage,
      confidence: derived.status === "ok" ? derived.confidence : null,
      provenance: derived.provenance,
      reason: derived.status === "insufficient" ? derived.reason : null,
    });
  },
);
