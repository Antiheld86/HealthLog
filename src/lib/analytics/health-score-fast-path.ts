/**
 * v1.4.37 W2 — probe-gated Health Score builder.
 *
 * The `/api/analytics` default slice builds the Personal Health Score
 * by combining BP-in-target % (already computed upstream) with three
 * additional pillars: weight-trend alignment, mood stability, and
 * medication compliance. Up to v1.4.37 the route inlined four parallel
 * `findMany` reads (weight 37 days, BP-SYS 30 days for source pills,
 * mood 37 days, active medications) plus a fifth for intake events.
 * On a cold connection pool the round-trip latency stacks — the
 * v1.4.36 perf-verify recorded the bp_in_target + healthScore +
 * correlations fan-out at 111 s wall-clock against the maintainer's
 * 311 779-row tenant.
 *
 * Read shape (v1.4.37)
 * --------------------
 *   1. **Probe** — `probeRollupCoverage` returns the per-type DAY-bucket
 *      coverage map. When WEIGHT is covered we take the rollup-fast-path
 *      for the weight pillar; the slope/alignment math runs against
 *      per-day MEAN weight derived from `measurement_rollups` instead
 *      of the raw `measurements` table.
 *
 *   2. **Source attribution** — only the raw rows know which ingest
 *      path produced each reading, so the per-component
 *      `HealthScoreSourceAttribution` slice still needs a narrow read
 *      against `measurements` (selecting only `source` + `measuredAt`).
 *      That read is cheap (30-day window, 2-column projection) and
 *      stays live regardless of coverage.
 *
 *   3. **Live fallback** — when the probe shows WEIGHT is not covered
 *      (brand-new user, no buckets yet) the helper reads the raw
 *      weight rows the same way the legacy route did so the score
 *      stays correct on first cold-mount.
 *
 * The mood / medication / compliance pillars don't have rollup
 * equivalents (the rollup table only carries `Measurement` aggregates)
 * — those reads remain live regardless. The path annotate on
 * `meta.healthScore.path` makes the branch selection visible in prod
 * logs.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { readRollupBuckets } from "@/lib/rollups/measurement-rollups";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "./compliance";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  computeHealthScore,
  type ContributingSource,
  type HealthScoreInput,
  type HealthScoreResult,
  type WeightTargetSource,
} from "./health-score";
import type { MeasurementSource } from "@/generated/prisma/client";

/**
 * v1.4.25 W8e — collapse the persisted `MeasurementSource` enum onto
 * the camelCase token set the health-score analytics layer consumes.
 *
 * - `MANUAL` and `IMPORT` (CSV import — still user-supplied data) both
 *   surface as `"manual"`.
 * - `WITHINGS` and `APPLE_HEALTH` ride one-to-one.
 *
 * Returns `null` for source values that don't fall into the three
 * exposed buckets — defence-in-depth in case the enum grows before the
 * client is taught about it.
 */
function mapMeasurementSourceToLabel(
  source: MeasurementSource,
): ContributingSource | null {
  switch (source) {
    case "MANUAL":
    case "IMPORT":
      return "manual";
    case "WITHINGS":
      return "withings";
    case "APPLE_HEALTH":
      return "appleHealth";
    default:
      return null;
  }
}

function uniqueComponentSources(
  rows: ReadonlyArray<MeasurementSource>,
): ReadonlyArray<ContributingSource> {
  const seen = new Set<ContributingSource>();
  for (const src of rows) {
    const label = mapMeasurementSourceToLabel(src);
    if (label) seen.add(label);
  }
  return Array.from(seen);
}

export interface HealthScoreFastPathInput {
  userId: string;
  bpInTargetPct: number | null;
  /**
   * v1.4.38 — prior-week BP-in-target pct so the week-over-week delta
   * reflects BP movement instead of always landing at zero for the
   * pillar. The caller is expected to run a second
   * `computeBpInTargetFastPath` against `now - 7d` and pass the
   * resulting `last30Days.pct` through. When omitted (legacy callers
   * predating v1.4.38) the helper falls back to `bpInTargetPct` —
   * preserves the pre-v1.4.38 behaviour exactly so the bump is
   * additive.
   */
  bpInTargetPctPriorWeek?: number | null;
  /**
   * v1.15.12 A1 — graded clinical-proximity BP score (0..100) from a
   * recency-weighted representative reading. When supplied it becomes
   * the BP pillar VALUE; the binary `bpInTargetPct` only decides pillar
   * presence and is surfaced as a secondary stat. Omit (legacy callers)
   * to keep the pre-v1.15.12 behaviour where the rate IS the score.
   */
  bpGradedScore?: number | null;
  /**
   * v1.15.12 A1 — prior-week graded BP score for the week-over-week
   * delta. Omit to fall back to `bpGradedScore` (BP cancels out of the
   * delta), mirroring the `bpInTargetPctPriorWeek` fallback.
   */
  bpGradedScorePriorWeek?: number | null;
  /**
   * v1.34 — the weight yardstick, resolved by the caller through
   * `buildHealthScoreWeightTarget`. The band the user set, or `null`
   * when they set none. Required, not defaulted: a forgotten caller must
   * fail to compile rather than silently fall back to a number nobody
   * chose — which is exactly how `22 × height²` graded every account for
   * months.
   */
  weightTarget: { min: number; max: number } | null;
  /** Which yardstick `weightTarget` came from. Required for the same reason. */
  weightTargetSource: WeightTargetSource;
  now: Date;
  /**
   * Per-type rollup coverage map. The caller (analytics route) probes
   * once and shares the result across all three fast-path helpers so
   * the probe cost stays flat in the fan-out.
   */
  coverage?: RollupCoverageMap;
  /**
   * v1.18.0 R4 — module-aware mood pillar. When the caller resolves the
   * `mood` module as disabled it threads `moodEnabled: false` and the
   * helper drops the 0.20 mood-stability pillar entirely: the mood read
   * is skipped and the series stays empty, so `moodStability` returns
   * `null` and the existing proportional null-redistribution re-scales
   * the surviving pillars to sum to 100. Without this a disabled-mood
   * account is silently penalised (or rewarded) by a pillar it can no
   * longer see anywhere else in the product.
   *
   * v1.34 — required. The field used to default to `true`, and the
   * dashboard snapshot never passed it: a mood-off account got a mood
   * pillar in the hero ring and none in the Insights card, the same
   * score composed two different ways on two surfaces. A required flag
   * makes the compiler name every caller.
   */
  moodEnabled: boolean;
}

/**
 * Public entrypoint. Returns the same shape `computeHealthScore`
 * returns, plus a `path` annotate emitted on the meta dict.
 *
 * Returns null when no component can be computed (the route surfaces
 * `null` to the UI so the hero panel hides cleanly).
 */
export async function computeUserHealthScoreFastPath(
  input: HealthScoreFastPathInput,
): Promise<HealthScoreResult | null> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const {
    userId,
    bpInTargetPct,
    now,
    moodEnabled,
    weightTarget,
    weightTargetSource,
  } = input;
  // v1.4.38 — prior-week BP fallback. When the caller omits the field
  // we pin to the current value (pre-v1.4.38 behaviour) so the helper
  // stays a drop-in replacement for legacy callers; when the caller
  // supplies it we feed it into the previous-window snapshot so the
  // delta reflects week-over-week BP movement instead of always
  // zeroing the BP pillar.
  const bpInTargetPctPriorWeek =
    input.bpInTargetPctPriorWeek === undefined
      ? bpInTargetPct
      : input.bpInTargetPctPriorWeek;
  const since30d = new Date(now.getTime() - 30 * DAY_MS);
  const prevSince30d = new Date(now.getTime() - 37 * DAY_MS);
  const prevUntil = new Date(now.getTime() - 7 * DAY_MS);

  const coverage = input.coverage ?? (await probeRollupCoverage(userId));
  // v1.4.38.8 — gate only on the WEIGHT type this helper reads. The
  // prior `isFullyCovered &&` AND poisoned the score fast-path with
  // any unrelated brand-new type that lacked rollup coverage. Per-
  // type coverage is the correct gate.
  const weightCovered = coverage.get("WEIGHT") === true;

  // Weight series — rollup-fast-path when fully covered, raw findMany
  // otherwise. The raw read selects only the columns the slope helper
  // and the source-attribution accordion need (value + measuredAt +
  // source) so the projection stays narrow.
  let weightSeriesLast30d: Array<{ date: string; kg: number }>;
  let weightSeriesPrev30d: Array<{ date: string; kg: number }>;
  let weightSourcesIn30d: ReadonlyArray<ContributingSource>;
  let latestWeightAsOf: string | null;
  // v1.4.40 W-WMY-WIRE — long-window weight baseline served from the
  // WEEK / MONTH / YEAR rollup tier. Used for the diagnostic annotate
  // so operators can verify the WMY readers actually serve production
  // traffic instead of sitting as dead write amplification (see
  // `.planning/round-v1438-perf-analysis.md` §2 + §5 P6). The score
  // shape stays unchanged; the long-window mean is annotate-only so
  // the v1.5 Coach drawer can opt into it later without breaking the
  // current contract.
  let weightLongWindowGranularity: string | null = null;
  let weightLongWindowMean: number | null = null;
  let weightLongWindowBucketCount = 0;

  if (weightCovered) {
    // Rollup-fast-path — per-day MEAN weight from `measurement_rollups`.
    // Linear regression on per-day means produces a slope equivalent
    // to per-event regression for a series with consistent sampling
    // cadence (one weigh-in per day is the canonical pattern).
    //
    // v1.4.40 W-WMY-WIRE — the long-window weight read runs in
    // parallel with the canonical DAY-bucket read so the wall-clock
    // cost stays flat. `readBestGranularityRollups(..., 365)` routes
    // the trailing-year window through MONTH (floor 181 d) by default
    // — typically 12 monthly buckets vs the ~365 DAY rows the live
    // path would scan. count / mean are linearly composable across
    // MONTH buckets so the derived mean is mathematically equivalent
    // to the per-row average over the same year-long window.
    // Coverage-fallback in the helper means a tenant with WEEK or DAY
    // coverage but no MONTH buckets still resolves to a usable mean.
    const [dayBuckets, longWindow] = await Promise.all([
      readRollupBuckets(userId, "WEIGHT", "DAY", prevSince30d, now),
      readBestGranularityRollups(userId, "WEIGHT", 365),
    ]);
    weightSeriesLast30d = dayBuckets
      .filter((b) => b.bucketStart >= since30d)
      .map((b) => ({
        date: b.bucketStart.toISOString(),
        kg: b.mean,
      }));
    weightSeriesPrev30d = dayBuckets
      .filter(
        (b) => b.bucketStart >= prevSince30d && b.bucketStart <= prevUntil,
      )
      .map((b) => ({
        date: b.bucketStart.toISOString(),
        kg: b.mean,
      }));
    if (longWindow && longWindow.rows.length > 0) {
      weightLongWindowGranularity = longWindow.granularity;
      weightLongWindowBucketCount = longWindow.rows.length;
      let totalCount = 0;
      let weighted = 0;
      for (const row of longWindow.rows) {
        totalCount += row.count;
        weighted += row.count * row.mean;
      }
      if (totalCount > 0) {
        weightLongWindowMean = weighted / totalCount;
      }
    }
    // Source attribution still needs the raw rows — only the raw table
    // carries the `source` enum. Pull the narrow 30-day window with a
    // 2-column projection so the round-trip stays minimal.
    const sourceRows = await prisma.measurement.findMany({
      where: {
        userId,
        type: "WEIGHT",
        measuredAt: { gte: since30d, lte: now },
        deletedAt: null,
      },
      select: { measuredAt: true, source: true },
      orderBy: { measuredAt: "asc" },
    });
    weightSourcesIn30d = uniqueComponentSources(
      sourceRows.map((r) => r.source),
    );
    latestWeightAsOf = sourceRows.at(-1)?.measuredAt.toISOString() ?? null;
  } else {
    // Live fallback — raw rows over the 37-day window. Mirrors the
    // pre-v1.4.37 behaviour exactly.
    const weightRows = await prisma.measurement.findMany({
      where: {
        userId,
        type: "WEIGHT",
        measuredAt: { gte: prevSince30d, lte: now },
        deletedAt: null,
      },
      select: { value: true, measuredAt: true, source: true },
      orderBy: { measuredAt: "asc" },
    });
    weightSeriesLast30d = weightRows
      .filter((r) => r.measuredAt >= since30d)
      .map((r) => ({ date: r.measuredAt.toISOString(), kg: r.value }));
    weightSeriesPrev30d = weightRows
      .filter((r) => r.measuredAt >= prevSince30d && r.measuredAt <= prevUntil)
      .map((r) => ({ date: r.measuredAt.toISOString(), kg: r.value }));
    weightSourcesIn30d = uniqueComponentSources(
      weightRows.filter((r) => r.measuredAt >= since30d).map((r) => r.source),
    );
    latestWeightAsOf =
      weightRows
        .filter((r) => r.measuredAt >= since30d)
        .at(-1)
        ?.measuredAt.toISOString() ?? null;
  }

  // Remaining reads — mood, BP-SYS source attribution, medications +
  // intake — run in parallel. None has a rollup equivalent today so
  // these are always live.
  const [bpSysRowsForSource, moodRows, medications] = await Promise.all([
    prisma.measurement.findMany({
      where: {
        userId,
        type: "BLOOD_PRESSURE_SYS",
        measuredAt: { gte: since30d, lte: now },
        deletedAt: null,
      },
      select: { measuredAt: true, source: true },
      orderBy: { measuredAt: "asc" },
    }),
    // v1.18.0 R4 — skip the read entirely when the mood module is off.
    // An empty series feeds `moodStability` → null → the 0.20 pillar
    // weight redistributes across the surviving pillars. Skipping the
    // query (rather than reading-then-discarding) keeps the disabled
    // module off the round-trip budget too.
    moodEnabled
      ? prisma.moodEntry.findMany({
          where: {
            userId,
            // v1.7.0 sync — exclude tombstoned rows.
            deletedAt: null,
            moodLoggedAt: { gte: prevSince30d, lte: now },
          },
          select: { score: true, moodLoggedAt: true },
          orderBy: { moodLoggedAt: "asc" },
        })
      : Promise.resolve([] as Array<{ score: number; moodLoggedAt: Date }>),
    prisma.medication.findMany({
      // v1.16.11 — as-needed (PRN) medications carry no expected doses
      // and are excluded from every compliance rate: they must
      // contribute neither 0% nor 100% to the score pillar.
      where: { userId, active: true, asNeeded: false },
      select: {
        id: true,
        createdAt: true,
        // v1.7.0 SB-SCHED-2 — the medication course-window fields the
        // canonical engine needs to expand expected slots.
        startsOn: true,
        endsOn: true,
        oneShot: true,
        // v1.25 M-MED3 — route through the SHARED compliance select like every
        // other caller, so the Health-Score pillar honours the same per-dose
        // on-time windows + cadence fields the dashboard / detail surfaces use.
        schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
        // v1.25 M-MED3 — archived schedule eras so a past day scores against
        // the schedule that was live THEN, not the current one (every other
        // compliance caller already threads these). The builder copies them
        // through into the context.
        scheduleRevisions: {
          orderBy: { validFrom: "asc" },
          select: {
            id: true,
            validFrom: true,
            validUntil: true,
            payload: true,
            supersededByRevisionId: true,
          },
        },
        // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
        pauseEras: { select: { pausedAt: true, resumedAt: true } },
      },
    }),
  ]);

  let medicationCompliance30: number[] = [];
  let medicationCompliance30Previous: number[] = [];
  if (medications.length > 0) {
    const medIds = medications.map((m) => m.id);
    const intakeEvents = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        // v1.7.0 sync — exclude tombstoned rows.
        deletedAt: null,
        medicationId: { in: medIds },
        scheduledFor: { gte: prevSince30d, lte: now },
      },
      select: {
        medicationId: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
      },
    });
    const eventsByMed = new Map<string, typeof intakeEvents>();
    for (const ev of intakeEvents) {
      const list = eventsByMed.get(ev.medicationId);
      if (list) list.push(ev);
      else eventsByMed.set(ev.medicationId, [ev]);
    }
    // v1.7.0 SB-SCHED-2 — resolve the user timezone once so the
    // compliance pillar routes its denominator through the canonical
    // engine. The pinned `now` is kept so the pillar still agrees with
    // the score's other pillars.
    const userTz = await resolveUserTimezone(userId);
    medicationCompliance30 = medications.map((med) => {
      const events = eventsByMed.get(med.id) ?? [];
      const medicationContext = buildComplianceMedicationContext(
        med,
        lastNonSkippedTakenAt(events),
        userTz,
      );
      // v1.5.0 — pass the helper's pinned `now` so the cadence-aware
      // window math agrees with the score's other pillars (which also
      // anchor to the same `now`). Closes #214.
      return calculateCompliance(events, med.schedules, 30, med.createdAt, {
        now,
        medicationContext,
      }).rate;
    });
    medicationCompliance30Previous = medications.map((med) => {
      const events = (eventsByMed.get(med.id) ?? []).filter(
        (e) => e.scheduledFor <= prevUntil,
      );
      // Shift forward by 7 days so the helper's `now` anchor still
      // captures the same logical 30 days (pre-v1.4.37 behaviour).
      const shifted = events.map((e) => ({
        scheduledFor: new Date(e.scheduledFor.getTime() + 7 * DAY_MS),
        takenAt: e.takenAt ? new Date(e.takenAt.getTime() + 7 * DAY_MS) : null,
        skipped: e.skipped,
      }));
      // v1.25 M-MED3 — `med` (and so its scheduleRevisions + pauseEras) is
      // passed UNshifted while the intake events shift +7d (the pre-existing
      // approximation that lets the pinned `now` anchor still capture the prior
      // logical 30 days). The revisions / pause eras are absolute historical
      // records; no canonical previous-window caller shifts them, so they stay
      // as-is here for consistency with the rest of the engine. Trade-off: in
      // the trailing-30-day DELTA the era / pause segmentation can be up to 7
      // days out of phase with the shifted slots. The primary (current-window)
      // score — `medicationCompliance30` above — is exact; only the secondary
      // trend delta carries this best-effort approximation.
      const medicationContext = buildComplianceMedicationContext(
        med,
        lastNonSkippedTakenAt(shifted),
        userTz,
      );
      return calculateCompliance(shifted, med.schedules, 30, med.createdAt, {
        now,
        medicationContext,
      }).rate;
    });
  }

  const moodSeriesLast30d = moodRows
    .filter((r) => r.moodLoggedAt >= since30d)
    .map((r) => ({
      date: r.moodLoggedAt.toISOString(),
      score: r.score,
    }));
  const moodSeriesPrev30d = moodRows
    .filter(
      (r) => r.moodLoggedAt >= prevSince30d && r.moodLoggedAt <= prevUntil,
    )
    .map((r) => ({
      date: r.moodLoggedAt.toISOString(),
      score: r.score,
    }));

  const windowEndAt = now.toISOString();

  const bpSourceTokens = uniqueComponentSources(
    bpSysRowsForSource.map((r) => r.source),
  );
  const latestBpInWindow = bpSysRowsForSource.at(-1);

  // Mood doesn't yet have a non-manual ingest (v1.5 will introduce
  // Apple Health mood) — preserve the manual-only contract.
  const moodSourceTokens =
    moodSeriesLast30d.length > 0 ? (["manual"] as const) : [];
  const latestMoodInWindow = moodRows
    .filter((r) => r.moodLoggedAt >= since30d)
    .at(-1);

  const complianceSourceTokens =
    medicationCompliance30.length > 0 ? (["manual"] as const) : [];

  const current: HealthScoreInput = {
    bpInTargetRate: bpInTargetPct,
    // v1.15.12 A1 — graded BP score drives the pillar value when present
    // (the binary rate above only gates presence + is the secondary stat).
    bpGradedScore: input.bpGradedScore ?? null,
    weightSeriesLast30d,
    weightTarget,
    weightTargetSource,
    moodEntriesLast30d: moodSeriesLast30d,
    medicationCompliance30,
    attribution: {
      bpSources: bpSourceTokens,
      asOfBp: latestBpInWindow?.measuredAt.toISOString() ?? null,
      weightSources: weightSourcesIn30d,
      asOfWeight: latestWeightAsOf,
      moodSources: moodSourceTokens,
      asOfMood: latestMoodInWindow?.moodLoggedAt.toISOString() ?? null,
      complianceSources: complianceSourceTokens,
      asOfCompliance: complianceSourceTokens.length > 0 ? windowEndAt : null,
      windowEndAt,
    },
  };

  // Previous-window snapshot — same logic, prior-week-shifted series.
  //
  // v1.4.38 — when the caller supplies `bpInTargetPctPriorWeek` we
  // use it so the delta reflects week-over-week BP movement. Legacy
  // callers that omit the field keep the pre-v1.4.38 behaviour where
  // BP cancels out of the delta because the helper pins both windows
  // to the same value. Re-computing the prior-week BP costs one
  // extra rollup-coverage read on the route side; the helper itself
  // stays single-pass.
  const previous: HealthScoreInput = {
    bpInTargetRate: bpInTargetPctPriorWeek,
    // v1.15.12 A1 — prior-week graded score so the week-over-week delta
    // reflects graded BP movement. Falls back to the current graded
    // score (delta cancels to zero for BP) when the caller omits it.
    bpGradedScore:
      input.bpGradedScorePriorWeek === undefined
        ? (input.bpGradedScore ?? null)
        : input.bpGradedScorePriorWeek,
    weightSeriesLast30d: weightSeriesPrev30d,
    weightTarget,
    weightTargetSource,
    moodEntriesLast30d: moodSeriesPrev30d,
    medicationCompliance30: medicationCompliance30Previous,
  };

  const result = computeHealthScore(current, previous);

  // No-pillar-eligible early-out — nothing computable, hero hides cleanly.
  //
  // The naive raw-record check this replaced only asked whether any pillar
  // had a nonzero row count, not whether that count cleared the pillar's own
  // eligibility bar: weight needs >= 2 readings, mood needs >= 5 entries, BP
  // needs a paired reading, compliance needs an active scheduled medication.
  // An account that clears the row-count check but misses every pillar's
  // bar (e.g. exactly one mood entry, or a single weight reading) fell
  // through to `computeHealthScore`, which sums no components and returns a
  // raw `0` — indistinguishable from a genuinely poor score. Checking the
  // COMPUTED result's components (the same eligibility rules the score
  // itself already applies) instead of re-deriving the thresholds here means
  // this can never drift out of sync with `computeHealthScore`. A component
  // that is legitimately computed as `0` still has `value: 0`, not `null`,
  // so it is never swept into this branch.
  const noComponentEligible =
    result.components.bp.value === null &&
    result.components.weight.value === null &&
    result.components.mood.value === null &&
    result.components.compliance.value === null;

  if (noComponentEligible) {
    annotate({
      meta: {
        healthScore: {
          score: null,
          reason: "no_components_available",
          path: weightCovered ? "rollup" : "live",
          weightLongWindow:
            weightLongWindowMean !== null
              ? {
                  mean: Math.round(weightLongWindowMean * 100) / 100,
                  granularity: weightLongWindowGranularity,
                  buckets: weightLongWindowBucketCount,
                }
              : null,
        },
      },
    });
    return null;
  }

  annotate({
    meta: {
      healthScore: {
        score: result.score,
        band: result.band,
        delta: result.delta,
        path: weightCovered ? "rollup" : "live",
        // v1.4.40 W-WMY-WIRE — the long-window weight baseline drawn
        // from the WEEK / MONTH / YEAR rollup tier. `null` when the
        // user lacks long-tail coverage or when the live fallback
        // branch ran (no probe issued). Surfaces the granularity the
        // router landed on so operators can see "rollup tier served
        // the year-long mean from MONTH buckets" in the wide-event.
        weightLongWindow:
          weightLongWindowMean !== null
            ? {
                mean: Math.round(weightLongWindowMean * 100) / 100,
                granularity: weightLongWindowGranularity,
                buckets: weightLongWindowBucketCount,
              }
            : null,
      },
    },
  });
  return result;
}
