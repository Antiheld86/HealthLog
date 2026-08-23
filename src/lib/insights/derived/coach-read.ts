/**
 * v1.21.2 (A1) — "Coach read" strip data builder.
 *
 * Two server-authoritative lines for a single metric sub-page, computed
 * here so web and iOS read the SAME resolved DTO (no client re-derivation):
 *
 *   1. own-baseline — the user's personal typical range (median ± k·MAD)
 *      from `computeVitalsBaseline`, plus where today's latest reading sits
 *      relative to it (within / above / below). Below the engine's 7-day
 *      history floor the band is `insufficient` and the strip says
 *      "still learning your range" — never a fabricated range.
 *   2. one lagged association — the single strongest discovered driver
 *      whose OUTCOME is this metric, surfaced from `readCoachCorrelations`
 *      (FDR-controlled, effect-size-floored, confidence-tiered). The line
 *      carries the engine's own never-causal interpretation verbatim. When
 *      nothing clears the existing floor the line is omitted entirely.
 *
 * Both inputs reuse the deterministic engines unchanged — no new statistics,
 * no lowered floor. Server-only by construction — only the metric-page
 * route imports it, and it reads Prisma. The DTO shapes + the pure selection
 * helpers live in the client-safe `coach-read-shape.ts` sibling so the strip
 * component and the unit test can share them without pulling Prisma.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { Locale } from "@/lib/i18n/config";
import {
  loadBaselineProfile,
  computeVitalsBaseline,
} from "@/lib/insights/derived/baseline";
import { isDerivedOk } from "@/lib/insights/derived";
import { readCoachCorrelations } from "@/lib/ai/coach/tools/correlations-read";
import {
  humaniseType,
  placeAgainstBand,
  pickDriverForMetric,
  type CoachReadBaseline,
  type CoachReadDriver,
  type CoachReadStripData,
} from "@/lib/insights/derived/coach-read-shape";

export type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * Read the latest reading for `(userId, type)` — the value the strip places
 * against the band. Display-side scaling (e.g. WALKING_SPEED m/s → km/h) is
 * the caller's concern; the strip renders unscaled stored values, and the
 * band is unscaled too, so the placement is scale-invariant.
 */
async function readLatestValue(
  userId: string,
  type: MeasurementType,
): Promise<number | null> {
  const row = await prisma.measurement.findFirst({
    where: { userId, type, deletedAt: null },
    orderBy: { measuredAt: "desc" },
    select: { value: true },
  });
  return row?.value ?? null;
}

/**
 * Build the "Coach read" strip payload for one metric. Pure orchestration
 * over the baseline + correlations engines; never throws on a partial read
 * (a correlations hiccup degrades line 2 to `null`, the band stands alone).
 */
export async function buildCoachReadStrip(
  userId: string,
  type: MeasurementType,
  /**
   * The reader's locale. Line 2 arrives as a finished sentence and is printed
   * verbatim by both clients, so it has to be written in the reader's language
   * HERE — the strip component only translates the wrapper around it. Required
   * on purpose: while this parameter did not exist, the route said nothing and
   * the sentence came back in English, which is how a German weight page ended
   * up with a German first line and an English second one.
   */
  locale: Locale,
): Promise<CoachReadStripData> {
  const profile = await loadBaselineProfile(prisma, userId);

  const [baselineDerived, latest, correlations] = await Promise.all([
    computeVitalsBaseline(userId, profile, { type }),
    readLatestValue(userId, type),
    // Line 2 is best-effort: a correlation failure must never sink the band.
    readCoachCorrelations(userId, locale).catch(
      () => ({ present: false }) as const,
    ),
  ]);

  let baseline: CoachReadBaseline | null = null;
  let learning = false;

  if (isDerivedOk(baselineDerived) && latest !== null) {
    const { low, high, sampleDays } = baselineDerived.value;
    baseline = {
      low,
      high,
      latest,
      placement: placeAgainstBand(latest, low, high),
      sampleDays,
    };
  } else {
    // Band not established (history below the 7-day floor, or no readings) —
    // the strip says "still learning your range" rather than inventing one.
    learning = true;
  }

  const driver = ((): CoachReadDriver | null => {
    if (!("drivers" in correlations) || !correlations.drivers) return null;
    const picked = pickDriverForMetric(
      correlations.drivers,
      humaniseType(type),
    );
    if (!picked) return null;
    return {
      note: picked.note,
      behaviour: picked.behaviour,
      outcome: picked.outcome,
    };
  })();

  return { baseline, learning, driver };
}
