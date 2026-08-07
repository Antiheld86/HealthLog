/**
 * v1.28.21 — GLP-1 weight-plateau read endpoint.
 *
 * Surfaces the existing server-side plateau detector
 * (`detectGlp1Plateau`, v1.4.25) to the UI: until now the context only
 * fed the insight-generation prompt. The two GLP-1 curve surfaces (the
 * medication detail "Wirkung" tab and /insights/medications) render a
 * compact association-only note from this read. `plateau` is `null`
 * whenever the detector bows out (no active GLP-1 medication, < 21 days
 * on the current dose, weight still dropping, or fewer than two
 * readings), and the note hides cleanly. Mirrors the sibling
 * `/api/insights/glp1-timeline` read: per-user, cheap, no module gate
 * beyond auth. Auth via cookie or Bearer.
 */

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  detectGlp1Plateau,
  PLATEAU_WINDOW_DAYS,
} from "@/lib/insights/glp1-plateau";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");

  const plateau = await detectGlp1Plateau(user.id);

  annotate({
    action: { name: "insights.glp1-plateau.read" },
    meta: { detected: plateau !== null },
  });

  return apiSuccess({ plateau, windowDays: PLATEAU_WINDOW_DAYS });
});
