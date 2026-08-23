/**
 * v1.12.1 (D3) — feed FDR-surviving cross-metric correlations into the
 * per-metric assessment card.
 *
 * The discovery engine (`correlation-discovery.ts`) already computes, with
 * a real Pearson + exact p-value + Benjamini-Hochberg FDR control, which
 * behaviour×outcome pairs are statistically defensible. Until now that
 * intelligence only reached the period narrative; the per-metric cards —
 * where many users actually live — never saw it, so every card read in
 * isolation ("your resting HR is X") instead of relationally ("your
 * resting HR rose the same week your sleep dropped").
 *
 * This module runs the SAME full-matrix discovery the
 * `/api/insights/correlations` route runs (so a card never surfaces a pair
 * the correlations page wouldn't), then filters to the surviving pairs that
 * INVOLVE the current metric's discovery channel. That parity is structural
 * rather than asserted: both take their channel set from the one assembler in
 * `src/lib/insights/discovery-matrix.ts`, and
 * `src/__tests__/discovery-matrix-guard.test.ts` freezes the assembler as the
 * only place a matrix is built. The result is the engine's own conservative,
 * descriptive, never-causal `interpretation` strings — passed verbatim into
 * the prompt as grounded context.
 *
 * Read-only consumption. No new statistics are computed here; the only
 * changes vs the route are the filter to one metric and the raw (rather than
 * rollup-tiered) measurement read.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { Locale } from "@/lib/i18n/config";
import {
  discoverCorrelations,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
} from "@/lib/insights/correlation-discovery";
import { assembleDiscoveryMatrix } from "@/lib/insights/discovery-matrix";
import {
  decisionForEvidence,
  PATTERN_FAMILIES,
  syncAcceptedPatterns,
} from "@/lib/insights/correlation-patterns";
import type { RelevantCorrelation } from "@/lib/insights/assessment-context";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Trailing window for the discovery scan — mirrors the route. */
const WINDOW_DAYS = 180;

/**
 * The discovery-channel key a `MeasurementType` participates as, or null
 * when the metric is not part of the curated discovery matrix. The channel
 * key equals the measurement type for every participating metric
 * (`TIME_IN_DAYLIGHT`, `BLOOD_GLUCOSE`, `ACTIVITY_STEPS`, `SLEEP_DURATION`,
 * `HEART_RATE_VARIABILITY`, `RESTING_HEART_RATE`).
 */
function channelKeyForType(type: MeasurementType): string | null {
  const key = type as string;
  if (
    (DISCOVERY_BEHAVIOURS as readonly string[]).includes(key) ||
    (DISCOVERY_OUTCOMES as readonly string[]).includes(key)
  ) {
    return key;
  }
  return null;
}

/**
 * Fetch the FDR-surviving correlations that involve `measurementType`.
 *
 * Returns an empty array when the metric is not a discovery channel, when
 * there is too little paired data, or when no pair survives the FDR control
 * — the relations prompt block then simply drops out. Best-effort: any
 * read/compute failure resolves to `[]` so a correlation hiccup can never
 * block the assessment generation it only decorates.
 */
export async function getRelevantCorrelationsForMetric(
  userId: string,
  measurementType: MeasurementType,
  /**
   * The reader's locale. These interpretations are finished sentences that go
   * into the assessment prompt as grounded context; handing a German card's
   * prompt English prose invites the model to echo it. Required — every caller
   * is a status builder that already knows the reader's language.
   */
  locale: Locale,
): Promise<RelevantCorrelation[]> {
  const channel = channelKeyForType(measurementType);
  if (!channel) return [];

  try {
    const profile = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const tz = profile?.timezone ?? "Europe/Berlin";
    const since = new Date(Date.now() - WINDOW_DAYS * MS_PER_DAY);

    // The channel set is the shared one — every family the correlations page
    // scans, so a card can never be missing a pair the page would show. The
    // measurement read stays `"raw"` (the route's rollup read-swap is a
    // read-cost choice, not a channel-set one; see the option's doc comment).
    const { series } = await assembleDiscoveryMatrix(userId, {
      tz,
      since,
      fetchMode: "raw",
    });

    const result = discoverCorrelations(series, { locale });
    const decisions = await syncAcceptedPatterns({
      userId,
      family: PATTERN_FAMILIES.discoveryRetrospective,
      accepted: result.discovered.map((pattern) => ({
        factorKey: pattern.behaviour,
        outcomeKey: pattern.outcome,
        lagDays: pattern.lagDays,
        sampleSize: pattern.n,
        effectSize: pattern.r,
        pValue: pattern.pValue,
        qValue: pattern.qValue,
      })),
    });
    return (
      result.discovered
        // The pair has to INVOLVE this metric. This filter is the difference
        // between the function's name and a full dump of the matrix: without
        // it, a WEIGHT card's prompt is handed "your daylight goes with your
        // sleep" as grounded context for a paragraph about weight. It was here
        // from the start and was lost when the pattern-dismissal filter was
        // written in its place rather than after it; the docstring, the name
        // and the `channelKeyForType` guard above all kept saying otherwise.
        .filter((d) => d.behaviour === channel || d.outcome === channel)
        .filter((d) => {
          const decision = decisionForEvidence(decisions, {
            factorKey: d.behaviour,
            outcomeKey: d.outcome,
            lagDays: d.lagDays,
          });
          return decision?.dismissed !== true;
        })
        .map((d) => ({ interpretation: d.interpretation, n: d.n, r: d.r }))
    );
  } catch {
    return [];
  }
}
