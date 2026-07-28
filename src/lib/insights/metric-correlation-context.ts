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
 * INVOLVE the current metric's discovery channel. The result is the
 * engine's own conservative, descriptive, never-causal `interpretation`
 * strings — passed verbatim into the prompt as grounded context.
 *
 * Read-only consumption. No new statistics are computed here; the only
 * change vs the route is the filter to one metric and a shorter window cap.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  discoverCorrelations,
  discoveryMeasurementTypes,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
  type NamedSeries,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
} from "@/lib/insights/correlation-discovery";
import {
  buildMeasurementDailySeries,
  fetchComplianceSeries,
  fetchCustomMetricBehaviourSeries,
  fetchEnvironmentSeries,
  fetchMeasurementWindowSeries,
  fetchMoodWindowSeries,
  fetchSymptomSeries,
} from "@/lib/insights/correlation-channel-series";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
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

    // Non-measurement channels (MOOD, and v1.21.0 MEDICATION_COMPLIANCE /
    // SYMPTOM_SEVERITY) are backed by other models — `discoveryMeasurementTypes`
    // strips them from the measurement `type IN (...)` query (a non-enum string
    // would error the cast). This per-metric-card surface does not populate the
    // compliance / symptom channels (they degrade to absent here); the
    // canonical `/api/insights/correlations` route builds them.
    const behaviourTypes = discoveryMeasurementTypes(
      DISCOVERY_BEHAVIOURS,
    ) as MeasurementType[];
    const outcomeTypes = discoveryMeasurementTypes(
      DISCOVERY_OUTCOMES,
    ) as MeasurementType[];

    // v1.30.3 (QA F1) — the fetch + desc/cap/resort discipline (a dense
    // account's cap must fall on the OLDEST rows, never the newest) now
    // lives in `fetchMeasurementWindowSeries` / `fetchMoodWindowSeries`
    // (`correlation-channel-series.ts`), shared with the route, the Coach
    // tool, and the period narrative.
    const [
      { byType },
      { moodDaily },
      priorityJson,
      complianceSeries,
      symptomSeries,
      environmentSeries,
      customMetricSeries,
    ] = await Promise.all([
      fetchMeasurementWindowSeries(userId, since, [
        ...behaviourTypes,
        ...outcomeTypes,
      ]),
      fetchMoodWindowSeries(userId, tz, since),
      loadUserSourcePriority(userId),
      fetchComplianceSeries(userId, tz, since),
      fetchSymptomSeries(userId, tz, since),
      fetchEnvironmentSeries(userId, since),
      fetchCustomMetricBehaviourSeries(userId, tz, since),
    ]);

    const points = (key: string) =>
      key === "MOOD"
        ? moodDaily
        : buildMeasurementDailySeries(
            key as MeasurementType,
            byType.get(key) ?? [],
            tz,
            priorityJson,
          );

    const series: NamedSeries[] = [];
    for (const key of DISCOVERY_BEHAVIOURS) {
      if (key === MEDICATION_COMPLIANCE_CHANNEL_KEY) {
        series.push(complianceSeries);
      } else if (key === SYMPTOM_SEVERITY_CHANNEL_KEY) {
        series.push({ ...symptomSeries, role: "behaviour" });
      } else {
        series.push({ key, role: "behaviour", points: points(key) });
      }
    }
    for (const key of DISCOVERY_OUTCOMES) {
      if (key === SYMPTOM_SEVERITY_CHANNEL_KEY) {
        series.push({ ...symptomSeries, role: "outcome" });
      } else {
        series.push({ key, role: "outcome", points: points(key) });
      }
    }
    series.push(...environmentSeries, ...customMetricSeries);

    const result = discoverCorrelations(series);
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
    return result.discovered
      .filter((d) => {
        const decision = decisionForEvidence(decisions, {
          factorKey: d.behaviour,
          outcomeKey: d.outcome,
          lagDays: d.lagDays,
        });
        return decision?.dismissed !== true;
      })
      .map((d) => ({ interpretation: d.interpretation, n: d.n, r: d.r }));
  } catch {
    return [];
  }
}
