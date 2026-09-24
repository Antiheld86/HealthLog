import { prisma } from "@/lib/db";
import { getBmiSystemPrompt, getBmiUserPrompt } from "@/lib/ai/prompts/bmi";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import type { Locale } from "@/lib/i18n/config";
import { classifyBMI } from "@/lib/analytics/classifications";
import { getNoKeyBmiStatusText } from "@/lib/insights/no-key-fallbacks";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import {
  buildAssessmentContextBlock,
  computeSteadyRun,
  pickVarietyLead,
} from "@/lib/insights/assessment-context";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesWithRollups,
  scaleGradedSeries,
  degradeStatusSnapshotToBudget,
} from "@/lib/insights/graded-series";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import {
  type SupportedLocale,
  normalizeLocale,
  finalizeStatusSummary,
  persistStatusInsight,
  round,
  summarizeSeries,
} from "@/lib/insights/status-shared";
import {
  computeStatusInputFingerprint,
  gateUnchangedStatusInput,
  readFreshStatusText,
  refreshUnchangedStatusInsight,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
} from "@/lib/insights/status-cache";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import {
  runPreparedStatusCard,
  type PreparedStatusCard,
  type StatusCardResult,
} from "@/lib/insights/status-card-generation";
import { annotate } from "@/lib/logging/context";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";

/**
 * Public entry — unchanged signature. Prepares the card (cache-read,
 * read-only miss, snapshot build, hash gate) then, when the LLM is still
 * needed, runs ONE completion through the shared single-card path. The
 * one-call-per-metric behaviour and the timeout / no-provider fallbacks are
 * byte-for-byte the same as before the prepare split (v1.18.7 HIGH-1).
 */
export async function generateBmiStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    /** v1.8.3 — read-only navigation path; see weight-status for the rationale. */
    readOnly?: boolean;
  },
): Promise<{
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  /** v1.9.0 — last-good text served while a refresh is in flight; keep polling. */
  revalidating?: boolean;
}> {
  const prepared = await prepareBmiStatusForUser(userId, options);
  const result = await runPreparedStatusCard(prepared);
  return result as {
    hasProvider: boolean;
    text: string | null;
    cached: boolean;
    updatedAt: string | null;
    preparing?: boolean;
    revalidating?: boolean;
  };
}

/**
 * v1.18.7 (HIGH-1) — everything up to (not including) the provider call.
 * Returns a finished `served` result for every path that never needed the
 * LLM, or a `pending` descriptor the single-card path and the batch path
 * both drive. See `status-card-generation.ts` for the contract.
 */
export async function prepareBmiStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    /** v1.8.3 — read-only navigation path; see weight-status for the rationale. */
    readOnly?: boolean;
  },
): Promise<PreparedStatusCard> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const readOnly = options?.readOnly === true;
  const cacheAction = statusCacheAction("bmi", locale);
  // v1.30.3 (QA F5) — resolve the user's own tz BEFORE the day-key so the
  // cache rolls over at the user's local midnight, not Berlin's. Has to
  // happen ahead of the cache read below (the earliest possible return
  // path), not just the later day-bucketing reads.
  const userTz = await resolveUserTimezone(userId);
  const todayKey = userDayKey(new Date(), userTz);

  const cached = await readFreshStatusText({
    userId,
    cacheAction,
    todayKey,
    force,
  });
  if (cached) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: cached.text,
        cached: true,
        updatedAt: cached.updatedAt,
      },
    };
  }

  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId,
      metric: "bmi",
      locale,
    });
    // Unavailable for any reason serves the deterministic line and enqueues
    // nothing. `hasProvider` is provider presence only.
    if (outcome.kind === "unavailable") {
      return {
        phase: "served",
        result: {
          hasProvider: outcome.hasProvider,
          text: getNoKeyBmiStatusText(locale),
          cached: true,
          updatedAt: null,
        },
      };
    }
    // v1.8.7 — stale-while-revalidate: serve the last good assessment
    // (if any) instantly while the worker re-warms; only fall to the empty
    // preparing skeleton when none was ever produced.
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: outcome.lastGood?.text ?? null,
        cached: outcome.lastGood !== null,
        updatedAt: outcome.lastGood?.updatedAt ?? null,
        preparing: outcome.lastGood === null,
        revalidating: outcome.revalidating,
      },
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
    },
  });

  if (!user?.heightCm || user.heightCm <= 0) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text:
          locale === "de"
            ? "Für die BMI-Einschätzung fehlen aktuell Größenangaben im Profil."
            : "BMI assessment currently requires height data in the profile.",
        cached: true,
        updatedAt: null,
      },
    };
  }

  // v1.18.11 (P6) — input gate for this slow-moving metric. The snapshot
  // derives from WEIGHT rows and the profile heightCm; a cheap probe over
  // both fingerprints the inputs, so a non-forced unchanged week re-stamps
  // the cached assessment and skips the whole build (findMany + BMI series +
  // provider). A forced run never gates but still records a current
  // fingerprint for the next day's gate.
  const inputHash = await computeStatusInputFingerprint({
    userId,
    types: ["WEIGHT"],
    extra: { heightCm: user.heightCm },
  });
  if (!force) {
    const unchangedInput = await gateUnchangedStatusInput({
      userId,
      cacheAction,
      todayKey,
      inputHash,
      force,
    });
    if (unchangedInput) {
      return {
        phase: "served",
        result: {
          hasProvider: true,
          text: unchangedInput.text,
          cached: true,
          updatedAt: unchangedInput.updatedAt,
        },
      };
    }
  }

  // v1.4.28 FB-D2 — cap the snapshot input (weight runs at most once
  // per day for typical users; 365 covers a full year while the
  // downstream payload budget trims further).
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: "WEIGHT",
        // Soft-deleted rows must never reach the prompt snapshot.
        deletedAt: null,
      },
      orderBy: { measuredAt: "desc" },
      take: 365,
      select: {
        value: true,
        measuredAt: true,
      },
    })
    .then((rows) => rows.reverse());

  const now = new Date();
  // v1.2.5 (M-TZ3) — bucket day windows on the user's own calendar so a
  // near-midnight reading lands on the user's day for non-Berlin self-hosters.
  // `userTz` was already resolved above for the cache day-key.
  const heightFactor = (user.heightCm / 100) ** 2;

  const bmiPoints = measurements.map((measurement) => ({
    measuredAt: measurement.measuredAt,
    value: round(measurement.value / heightFactor, 2),
  }));
  // `applyPayloadBudget` daily buckets drive the latest/previous focus;
  // the compact graded series is what reaches the prompt.
  const weightSeries = applyPayloadBudget(bmiPoints, { now, tz: userTz });
  // BMI has no rollup tier of its own — it is weight ÷ height², a linear
  // transform by the per-user height factor. Read the WEIGHT tier (recent
  // / weekly from a bounded raw read, monthly / yearly from MONTH / YEAR)
  // and scale by 1 / heightFactor; the scaled series is exact.
  const weightGraded = await buildGradedSeriesWithRollups(
    userId,
    "WEIGHT",
    now,
  );
  const bmiGraded = scaleGradedSeries(weightGraded, 1 / heightFactor, 2);
  const bmiSeries = {
    daily: weightSeries.daily,
    monthly: weightSeries.monthly,
  };

  // daily[0] = newest bucket (lowest dayOffset).
  const latestBmi = bmiSeries.daily[0] ?? null;
  const previousBmi = bmiSeries.daily[1] ?? null;
  const latestClassification = latestBmi ? classifyBMI(latestBmi.value) : null;

  const oldestMeasurement =
    measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestMeasurement =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const totalSpanDays =
    oldestMeasurement && newestMeasurement
      ? Math.round(
          (newestMeasurement.getTime() - oldestMeasurement.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestMeasurementDaysAgo = newestMeasurement
    ? Math.round(
        (Date.now() - newestMeasurement.getTime()) / (24 * 60 * 60 * 1000),
      )
    : null;

  // v1.18.10 (HIGH-4) — hand the model the finished recent-vs-baseline
  // comparison + normal-swing verdict instead of asking it to derive them.
  // BMI reads against the WHO healthy band; "target-band" framing.
  const bmiSignal = buildMetricSignal({
    metric: locale === "en" ? "your BMI" : "dein BMI",
    direction: "target-band",
    graded: bmiGraded,
    normalRange: { low: 18.5, high: 24.9 },
    newestDaysAgo: newestMeasurementDaysAgo,
  });

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    focus: "bmi",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo,
    },
    bmi: {
      ...(bmiSignal ? { signal: bmiSignal } : {}),
      summary: summarizeSeries(
        bmiSeries.daily.map((bucket) => ({ value: bucket.value })),
      ),
      series: bmiGraded,
      latestDayFocus: latestBmi
        ? {
            dayOffset: latestBmi.dayOffset,
            value: latestBmi.value,
            classification: latestClassification,
            deltaToPreviousDailyPoint:
              previousBmi == null
                ? null
                : round(latestBmi.value - previousBmi.value, 2),
          }
        : null,
      target: {
        greenMin: 18.5,
        greenMax: 24.9,
      },
    },
  };

  const shed = degradeStatusSnapshotToBudget(
    snapshot as unknown as Record<string, unknown>,
  );
  const snapshotJson = JSON.stringify(snapshot, null, 2);

  annotate({
    action: { name: cacheAction },
    meta: {
      payload_size_bytes: snapshotJson.length,
      ...(shed.length > 0 ? { snapshot_shed: shed } : {}),
    },
  });

  // Content-hash gate (v1.16.8): when the snapshot is unchanged since the
  // last real assessment, refresh the cache timestamp and skip the LLM.
  const snapshotHash = hashInsightSnapshot(snapshot);
  const unchanged = await refreshUnchangedStatusInsight({
    userId,
    cacheAction,
    todayKey,
    snapshotHash,
  });
  if (unchanged) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: unchanged.text,
        cached: true,
        updatedAt: unchanged.updatedAt,
      },
    };
  }

  const previousContext = await getPreviousInsightContext(
    userId,
    "bmi-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  // v1.12.7 — diversity / anti-repetition block (see blood-pressure-status).
  // BMI is a per-user height transform of WEIGHT (no discovery channel of its
  // own), so the RELATIONS sub-block stays empty; the variety / data-strength
  // / repetition signals carry the rotation.
  const varietyLead = pickVarietyLead(userId, "bmi", todayKey);
  const steadyRun = computeSteadyRun(bmiGraded.weekly, bmiGraded.monthly);
  const assessmentContextBlock = buildAssessmentContextBlock(
    {
      varietyLead,
      dataStrength: {
        points: bmiSeries.daily.length,
        newestDaysAgo: newestMeasurementDaysAgo,
      },
      repeatCount: steadyRun,
      relations: [],
    },
    locale,
  );

  // The provider call is deferred to the caller — the single-card path runs
  // ONE completion, the batch path folds this prompt into one shared call.
  // A timeout / error is a transient miss (fallback served, no assessment
  // persisted); `none` (no provider / no consent) serves the no-key text.
  return {
    phase: "pending",
    metric: "bmi",
    userId,
    cacheAction,
    systemPrompt: getBmiSystemPrompt(locale),
    userPrompt: getBmiUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
      assessmentContextBlock,
      // v1.28.40 — rotating opener hint, per (user, metric, day).
      openerArchetypeHint(`${userId}:bmi:${todayKey}`, locale as Locale),
    ),
    snapshotHash,
    // v1.12.7 — match the archetype cards' 0.45.
    temperature: 0.45,
    noProvider: {
      hasProvider: false,
      text: getNoKeyBmiStatusText(locale, bmiSignal),
      cached: true,
      updatedAt: null,
    },
    timeout: (reason): StatusCardResult =>
      returnTimeoutFallback({
        cacheAction,
        reason,
        userId,
        todayKey,
        stubText: getNoKeyBmiStatusText(locale, bmiSignal),
      }),
    finalize: async (outcome): Promise<StatusCardResult> => {
      // Outbound safety screen. The only transform here used to be
      // whitespace-normalisation, so a dose-change imperative or a fabricated
      // clinical risk score persisted as the day's cached assessment. Policy
      // for a background-generated card is WITHHOLD: serve the deterministic
      // stub and persist no model text (see `finalizeStatusSummary`).
      const screened = finalizeStatusSummary(outcome.content, locale);
      if (!screened.ok) {
        annotate({
          action: { name: "insights.status.outbound_blocked" },
          meta: { cacheAction, reason: screened.reason },
        });
        return returnTimeoutFallback({
          cacheAction,
          reason: "screened",
          userId: userId,
          todayKey: todayKey,
          stubText: getNoKeyBmiStatusText(locale, bmiSignal),
        });
      }
      const summary = screened.text;
      if (!summary) {
        throw new Error("Bmi-status summary was empty after normalization");
      }
      const updatedAt = await persistStatusInsight({
        userId,
        cacheAction,
        todayKey,
        text: summary,
        snapshotHash,
        // v1.18.11 (P6) — persist the input fingerprint for tomorrow's gate.
        inputHash,
      });
      return {
        hasProvider: true,
        text: summary,
        cached: false,
        updatedAt,
      };
    },
  };
}

export function resolveBmiStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
