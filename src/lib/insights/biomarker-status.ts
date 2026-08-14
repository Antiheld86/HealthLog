/**
 * Per-biomarker assessment generator.
 *
 * Mirrors `generateMetricStatus` (the generic HealthKit-metric generator)
 * but reads `LabResult` rows for one user-scoped `Biomarker` instead of
 * `Measurement` rows for a `MeasurementType`. It reuses the exact same
 * machinery the metric cards use:
 *   - the shared provider runner (`runStatusCompletion`),
 *   - the stale-while-revalidate read-only path (`resolveReadOnlyStatusMiss`),
 *   - the standard cache-row persist (`persistStatusInsight`),
 *   - the cheap INPUT gate (`gateUnchangedStatusInput`) keyed on the latest
 *     reading fingerprint so a fresh assessment is produced ONLY when a new
 *     reading lands — an idle day re-stamps the cached text without an LLM
 *     round-trip.
 *
 * The return shape is byte-identical to the metric generator so
 * `InsightStatusCard` consumes it unchanged. The cache scope is
 * `biomarker:<id>`, which the on-demand queue worker routes back here.
 *
 * Empty-data guard: a marker with no numeric readings returns an
 * `insufficient` marker WITHOUT touching the provider chain.
 */
import { prisma } from "@/lib/db";
import { PROMPT_VERSION } from "@/lib/ai/prompts/base-system";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  getBiomarkerSystemPrompt,
  getBiomarkerUserPrompt,
} from "@/lib/ai/prompts/biomarker";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import type { Locale } from "@/lib/i18n/config";
import {
  classifyAgainstEffectiveRange,
  resolveEffectiveReferenceRange,
} from "@/lib/labs/reference-range";
import { getNoKeyBiomarkerStatusText } from "@/lib/insights/no-key-fallbacks";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import {
  normalizeLocale,
  finalizeStatusSummary,
  persistStatusInsight,
  summarizeSeries,
} from "@/lib/insights/status-shared";
import {
  gateUnchangedStatusInput,
  readFreshStatusText,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
} from "@/lib/insights/status-cache";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import { annotate } from "@/lib/logging/context";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";

export interface BiomarkerStatusResult {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  /** True when last-good text is served while a fresh generation runs. */
  revalidating?: boolean;
  /** True when the marker has no numeric readings; no LLM was called. */
  insufficient?: boolean;
}

/** The `biomarker:<id>` cache/queue scope for one marker. */
export function biomarkerStatusScope(
  biomarkerId: string,
): `biomarker:${string}` {
  return `biomarker:${biomarkerId}`;
}

/** Cap on the recent reading rows folded into the prompt snapshot. */
const SNAPSHOT_READING_CAP = 60;

interface BiomarkerReading {
  id: string;
  value: number;
  takenAt: Date;
}

function insufficient(): BiomarkerStatusResult {
  return {
    hasProvider: true,
    text: null,
    cached: false,
    updatedAt: null,
    insufficient: true,
  };
}

/**
 * Generate (or read from cache) the assessment for one biomarker. Mirrors
 * the metric generator's contract:
 *   - cache hit (today, non-stub) → serve it,
 *   - `readOnly` miss → enqueue out-of-band + serve last-good,
 *   - no numeric readings → `insufficient`, no LLM call,
 *   - unchanged latest reading → re-stamp cached text, no LLM call,
 *   - otherwise → build snapshot, run completion, persist.
 */
export async function generateBiomarkerStatus(args: {
  biomarkerId: string;
  userId: string;
  locale?: string | null;
  force?: boolean;
  /** Read-only navigation path — never blocks on the provider. */
  readOnly?: boolean;
}): Promise<BiomarkerStatusResult> {
  const marker = await prisma.biomarker.findFirst({
    where: { id: args.biomarkerId, userId: args.userId },
    select: {
      id: true,
      name: true,
      unit: true,
      lowerBound: true,
      upperBound: true,
    },
  });
  if (!marker) {
    // Unknown / cross-user marker — degrade gracefully rather than throwing.
    return insufficient();
  }

  const locale = normalizeLocale(args.locale);
  const force = args.force === true;
  const readOnly = args.readOnly === true;
  const scope = biomarkerStatusScope(marker.id);
  const cacheAction = statusCacheAction(scope, locale);
  // v1.30.3 (QA F5) — resolve the user's own tz BEFORE the day-key so the
  // cache rolls over at the user's local midnight, not Berlin's. Has to
  // happen ahead of the cache read below (the earliest possible return
  // path).
  const userTz = await resolveUserTimezone(args.userId);
  const todayKey = userDayKey(new Date(), userTz);

  const cached = await readFreshStatusText({
    userId: args.userId,
    cacheAction,
    todayKey,
    force,
  });
  if (cached) {
    return {
      hasProvider: true,
      text: cached.text,
      cached: true,
      updatedAt: cached.updatedAt,
    };
  }

  // Numeric readings only — a qualitative-only marker carries no range verdict
  // or trend, so there is nothing to assess. Done BEFORE any enqueue so an
  // empty marker never queues an LLM job nor blocks on the provider.
  const rows = await prisma.labResult.findMany({
    where: {
      userId: args.userId,
      biomarkerId: marker.id,
      deletedAt: null,
      value: { not: null },
    },
    orderBy: { takenAt: "desc" },
    take: SNAPSHOT_READING_CAP,
    select: {
      id: true,
      value: true,
      takenAt: true,
      // The window this reading's own report printed, when it carries one.
      // The verdict below is the reading's, not the marker's, so it has to
      // read the reading's window — see `resolveEffectiveReferenceRange`.
      sourceReferenceLow: true,
      sourceReferenceHigh: true,
      sourceReferenceText: true,
    },
  });
  if (rows.length === 0) {
    annotate({
      action: { name: "insights.biomarker-status.insufficient" },
      meta: { biomarkerId: marker.id },
    });
    return insufficient();
  }

  const readings: BiomarkerReading[] = rows.map((r) => ({
    id: r.id,
    value: r.value as number,
    takenAt: r.takenAt,
  }));
  const latest = readings[0];
  // The window the latest reading is judged against: its own report's range
  // when that reading carries one, the catalog band otherwise. One rule, the
  // same one the API DTO, the doctor report and the coach snapshot apply.
  const latestRange = resolveEffectiveReferenceRange(
    marker.lowerBound,
    marker.upperBound,
    rows[0],
  );
  const totalCount = await prisma.labResult.count({
    where: {
      userId: args.userId,
      biomarkerId: marker.id,
      deletedAt: null,
      value: { not: null },
    },
  });

  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId: args.userId,
      metric: scope,
      locale,
    });
    if (outcome.kind === "no-provider" || outcome.kind === "consent-missing") {
      return {
        hasProvider: false,
        text: getNoKeyBiomarkerStatusText(locale, marker.name),
        cached: true,
        updatedAt: null,
      };
    }
    return {
      hasProvider: true,
      text: outcome.lastGood?.text ?? null,
      cached: outcome.lastGood !== null,
      updatedAt: outcome.lastGood?.updatedAt ?? null,
      preparing: outcome.lastGood === null,
      revalidating: outcome.revalidating,
    };
  }

  // INPUT gate: fingerprint the latest reading + count + bounds + locale +
  // prompt version. When the fingerprint matches the cached assessment's
  // stored `inputHash`, nothing the prompt could see has changed since the
  // last reading, so re-stamp that text under today's day key and skip the
  // LLM entirely. A new reading flips the latest id / value / count and
  // forces a real regeneration — so the assessment regenerates ONLY on a new
  // reading.
  //
  // The gate runs with `force: false` even on the worker's forced path: the
  // outer `force` exists to bypass the SAME-DAY text cache (so a fresh day
  // re-evaluates the fingerprint), not to burn an LLM call on an unchanged
  // marker. The worker is re-enqueued whenever today's text cache misses, so
  // letting the input gate run keeps an idle marker to one cheap re-stamp per
  // day instead of a daily regeneration.
  const inputHash = hashInsightSnapshot({
    scope,
    locale,
    promptVersion: PROMPT_VERSION,
    count: totalCount,
    bounds: { lower: latestRange.low, upper: latestRange.high },
    latest: {
      id: latest.id,
      takenAt: latest.takenAt.toISOString(),
      value: latest.value,
    },
  });
  const unchanged = await gateUnchangedStatusInput({
    userId: args.userId,
    cacheAction,
    todayKey,
    inputHash,
    force: false,
  });
  if (unchanged) {
    return {
      hasProvider: true,
      text: unchanged.text,
      cached: true,
      updatedAt: unchanged.updatedAt,
    };
  }

  // Ascending series (oldest → newest) for the trend summary the prompt reads.
  const ascending = [...readings].reverse();
  const summary = summarizeSeries(ascending.map((r) => ({ value: r.value })));
  const latestStatus = classifyAgainstEffectiveRange(latest.value, latestRange);

  // The marker name/unit originate from `labResult.analyte` — model-
  // transcribed free text from an uploaded document (lab-biomarker-
  // backfill mints the catalog row from it). A hostile PDF could smuggle
  // instructions through them, and the name lands in SYSTEM-prompt
  // position below, so both are scrubbed exactly like the coach
  // labs-snapshot scrubs the same fields.
  const safeMarkerName = sanitizeForPrompt(marker.name, 120);
  const safeMarkerUnit = sanitizeForPrompt(marker.unit, 40);

  const snapshot = {
    locale,
    promptVersion: PROMPT_VERSION,
    generatedForDay: todayKey,
    marker: {
      name: safeMarkerName,
      unit: safeMarkerUnit,
      referenceRange:
        latestRange.low != null || latestRange.high != null
          ? { lower: latestRange.low, upper: latestRange.high }
          : null,
    },
    dataCoverage: {
      totalReadings: totalCount,
      readingsInSnapshot: readings.length,
      newestTakenAt: latest.takenAt.toISOString(),
      oldestInSnapshot: ascending[0].takenAt.toISOString(),
    },
    latest: {
      value: latest.value,
      takenAt: latest.takenAt.toISOString(),
      rangeStatus: latestStatus,
    },
    summary,
    series: ascending.map((r) => ({
      day: userDayKey(r.takenAt, userTz),
      value: r.value,
    })),
  };
  const snapshotJson = JSON.stringify(snapshot, null, 2);

  annotate({
    action: { name: cacheAction },
    meta: { payload_size_bytes: snapshotJson.length },
  });

  const outcome = await runStatusCompletion({
    userId: args.userId,
    cacheAction,
    consentSurface: "insights",
    systemPrompt: getBiomarkerSystemPrompt(safeMarkerName, locale as Locale),
    userPrompt: getBiomarkerUserPrompt(
      snapshotJson,
      todayKey,
      locale as Locale,
      // The rotating opener hint the sibling cards carry, keyed per
      // (user, marker, day) so consecutive markers do not all open alike.
      openerArchetypeHint(
        `${args.userId}:biomarker:${marker.id}:${todayKey}`,
        locale as Locale,
      ),
    ),
    temperature: AI_BUDGETS.statusArchetype.temperature,
    maxTokens: AI_BUDGETS.statusArchetype.maxTokens,
  });

  if (outcome.kind === "none") {
    return {
      hasProvider: false,
      text: getNoKeyBiomarkerStatusText(locale, marker.name),
      cached: true,
      updatedAt: null,
    };
  }
  if (outcome.kind === "timeout" || outcome.kind === "error") {
    return returnTimeoutFallback({
      cacheAction,
      reason: outcome.kind,
      userId: args.userId,
      todayKey,
      stubText: getNoKeyBiomarkerStatusText(locale, marker.name),
    });
  }

  // Outbound safety screen — WITHHOLD policy for a background-generated card.
  const screened = finalizeStatusSummary(outcome.content, locale);
  if (!screened.ok) {
    annotate({
      action: { name: "insights.status.outbound_blocked" },
      meta: { cacheAction, reason: screened.reason },
    });
    return returnTimeoutFallback({
      cacheAction,
      reason: "screened",
      userId: args.userId,
      todayKey,
      stubText: getNoKeyBiomarkerStatusText(locale, marker.name),
    });
  }
  const text = screened.text;
  if (!text) {
    throw new Error(`Biomarker-status summary was empty for ${marker.id}`);
  }

  const updatedAt = await persistStatusInsight({
    userId: args.userId,
    cacheAction,
    todayKey,
    locale,
    text,
    providerType: outcome.providerType,
    model: outcome.model,
    tokensUsed: outcome.tokensUsed,
    inputHash,
  });

  return { hasProvider: true, text, cached: false, updatedAt };
}
