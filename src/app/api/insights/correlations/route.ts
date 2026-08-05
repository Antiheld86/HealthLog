/**
 * GET /api/insights/correlations — FDR-controlled correlation discovery.
 *
 * v1.10.0 — promotes the former placeholder to the real discovery engine.
 * Scans a curated behaviour × outcome matrix (daylight / mood / glucose /
 * BP / steps × sleep / HRV / resting HR / weight), lag-joins each behaviour
 * day to the NEXT day's outcome, runs Pearson with the exact Student-t
 * p-value, and applies Benjamini-Hochberg FDR control across every tested
 * pair so only statistically-defensible patterns surface. Every surfaced
 * pair carries n, r, p, and the BH-adjusted q, framed descriptive — never
 * causal.
 *
 * Reads daily series bounded to a trailing window, day-keyed in the user's
 * display timezone (late-night readings mis-bucket under UTC). Pure compute
 * lives in `src/lib/insights/correlation-discovery.ts`; this route only
 * fetches + day-keys + responds. No LLM, no narrative, no cache table.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { prisma } from "@/lib/db";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  discoverCorrelations,
  discoverEmergingCorrelations,
  discoverLabOutcomeCorrelations,
  discoveryMeasurementTypes,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
  EARLY_WINDOW_DAYS,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import {
  decisionForEvidence,
  PATTERN_FAMILIES,
  syncAcceptedPatterns,
} from "@/lib/insights/correlation-patterns";
import {
  buildMeasurementDailySeries,
  fetchComplianceSeries,
  fetchCustomMetricBehaviourSeries,
  fetchEnvironmentSeries,
  fetchLabDraws,
  fetchMeasurementWindowSeries,
  fetchMoodWindowSeries,
  fetchSymptomSeries,
} from "@/lib/insights/correlation-channel-series";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";

export const dynamic = "force-dynamic";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Trailing window for the discovery scan (days). */
const WINDOW_DAYS = 180;

/** Day key (YYYY-MM-DD) for an instant in the user's display timezone. */
function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");

  // v1.15.20 — shared analytics-read budget (generous; caps runaway loops).
  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;

  // Operator can hide the correlation surface entirely.
  await requireAssistantSurface("correlations");

  const profile = await prisma.user.findUnique({
    where: { id: user.id },
    select: { timezone: true },
  });
  const tz = profile?.timezone ?? "Europe/Berlin";
  // Reader's locale for the narrated `interpretation` — the correlation cards
  // render this string verbatim, so it MUST be localised (cookie / User.locale /
  // Accept-Language). Without it the never-causal sentence leaked English into a
  // non-English UI.
  const locale = await resolveServerLocale({ userLocale: user.locale ?? null });
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY);

  // Non-MeasurementType channels are backed by other models, not measurements —
  // MOOD (MoodEntry), MEDICATION_COMPLIANCE (the dose-history ledger), and
  // SYMPTOM_SEVERITY (the illness day-log). `discoveryMeasurementTypes` drops
  // them so the `type IN (...)` query carries only real enum values; each is
  // built from its own source below and folded into the series.
  const behaviourTypes = discoveryMeasurementTypes(
    DISCOVERY_BEHAVIOURS,
  ) as MeasurementType[];
  const outcomeTypes = discoveryMeasurementTypes(
    DISCOVERY_OUTCOMES,
  ) as MeasurementType[];

  // v1.30.3 (QA F1) — the fetch + desc/cap/resort discipline now lives in
  // `fetchMeasurementWindowSeries` / `fetchMoodWindowSeries`
  // (`correlation-channel-series.ts`), shared with the Coach tool, the
  // per-metric card, and the period narrative so a fourth independently-
  // maintained copy can't drift the way the period-narrative one did.
  const [
    { byType: measurementsByType, measurementsCapped },
    moodWindow,
    priorityJson,
  ] = await Promise.all([
    fetchMeasurementWindowSeries(user.id, since, [
      ...behaviourTypes,
      ...outcomeTypes,
    ]),
    fetchMoodWindowSeries(user.id, tz, since),
    loadUserSourcePriority(user.id),
  ]);
  const { moodDaily, moodCapped } = moodWindow;

  // v1.21.0 (FDREXTEND) — build the two non-measurement, non-mood channels from
  // their own sources. Each degrades to an empty series when the user has no
  // data, so the discovery loop drops the channel (it cannot clear n ≥ 20).
  // v1.22 — lab draws (for the labs ↔ outcome pass) fetch alongside.
  const [
    complianceSeries,
    symptomSeries,
    labDraws,
    environmentSeries,
    customMetricSeries,
  ] = await Promise.all([
    fetchComplianceSeries(user.id, tz, since),
    fetchSymptomSeries(user.id, tz, since),
    fetchLabDraws(user.id, tz, since),
    // v1.25 (W-ENV) — environmental-exposure behaviour channels (weather /
    // daylight). Empty when the module is off / no home set, so the channels
    // degrade to absent. The module gate is implicit: no rows ⇒ no channels.
    fetchEnvironmentSeries(user.id, since),
    fetchCustomMetricBehaviourSeries(user.id, tz, since),
  ]);

  const points = (key: string): DailySeriesPoint[] =>
    key === "MOOD"
      ? moodDaily
      : buildMeasurementDailySeries(
          key as MeasurementType,
          measurementsByType.get(key) ?? [],
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
  // v1.25 (W-ENV) — fold the environmental-exposure behaviour channels in. They
  // pair (lag D → D+1) against every outcome above; the n ≥ 20 / FDR / effect-
  // size gates apply unchanged, so a thin weather series degrades to absent.
  for (const envSeries of environmentSeries) {
    series.push(envSeries);
  }
  for (const customSeries of customMetricSeries) {
    series.push(customSeries);
  }

  const result = discoverCorrelations(series, { locale });

  // v1.22 — rolling early-detection pass over the trailing window, re-using
  // the already-built series (no extra DB read). Emerging pairs exclude anything
  // the retrospective scan already established (no double-count).
  const recentFromDayKey = tzDayKey(
    new Date(now.getTime() - EARLY_WINDOW_DAYS * MS_PER_DAY),
    tz,
  );
  const emerging = discoverEmergingCorrelations(series, result, {
    recentFromDayKey,
    locale,
  });

  // v1.22 — labs ↔ outcome pass (point-vs-window over sparse draws). Degrades
  // to absent when the user has too few draws to clear the per-pair floor.
  const labCorrelations = discoverLabOutcomeCorrelations(labDraws, series, {
    locale,
  });

  const toEvidence = (pattern: (typeof result.discovered)[number]) => ({
    factorKey: pattern.behaviour,
    outcomeKey: pattern.outcome,
    lagDays: pattern.lagDays,
    sampleSize: pattern.n,
    effectSize: pattern.r,
    pValue: pattern.pValue,
    qValue: pattern.qValue,
  });
  const [retrospectiveDecisions, recentDecisions] = await Promise.all([
    syncAcceptedPatterns({
      userId: user.id,
      family: PATTERN_FAMILIES.discoveryRetrospective,
      accepted: result.discovered.map(toEvidence),
      computedAt: now,
    }),
    syncAcceptedPatterns({
      userId: user.id,
      family: PATTERN_FAMILIES.discoveryRecent,
      accepted: emerging.emerging.map(toEvidence),
      computedAt: now,
    }),
  ]);
  const attachPatternDecision = (
    pattern: (typeof result.discovered)[number],
    decisions: typeof retrospectiveDecisions,
  ) => {
    const decision = decisionForEvidence(decisions, toEvidence(pattern));
    return decision ? { ...pattern, ...decision } : pattern;
  };
  const discovered = result.discovered.map((pattern) =>
    attachPatternDecision(pattern, retrospectiveDecisions),
  );
  const emergingWithDecisions = {
    ...emerging,
    emerging: emerging.emerging.map((pattern) =>
      attachPatternDecision(pattern, recentDecisions),
    ),
  };

  annotate({
    action: { name: "insights.correlations.discover" },
    meta: {
      pairs_tested: result.pairsTested,
      discovered: result.discovered.length,
      fdr_q: result.fdrQ,
      // PERFAUDIT M1 — surfaces when a dense account's window exceeded the
      // read cap. The cap now falls on the OLDEST rows (desc + take), so a
      // capped read still covers the recent window `discoverEmergingCorrelations`
      // needs; this only tells a dashboard the retrospective scan's older
      // half of the window may be thin.
      measurements_capped: measurementsCapped,
      mood_entries_capped: moodCapped,
      // FDREXTEND — per-channel day-counts so a dashboard can see whether the
      // two sparse new channels reached the n ≥ 20 floor or degraded to absent.
      compliance_days: complianceSeries.points.length,
      symptom_days: symptomSeries.points.length,
      // v1.22 — early-detection + labs reach.
      emerging: emerging.emerging.length,
      emerging_window_days: emerging.windowDays,
      lab_draws: labDraws.length,
      lab_correlations: labCorrelations.discovered.length,
      // v1.25 (W-ENV) — env channel reach (sum of stored daily points across
      // the exposure channels) so a dashboard can see whether weather was
      // available for the scan.
      environment_days: environmentSeries.reduce(
        (sum, s) => sum + s.points.length,
        0,
      ),
      custom_metric_channels: customMetricSeries.length,
      custom_metric_days: customMetricSeries.reduce(
        (sum, channel) => sum + channel.points.length,
        0,
      ),
    },
  });

  return apiSuccess({
    ...result,
    discovered,
    emerging: emergingWithDecisions,
    labCorrelations,
  });
});
