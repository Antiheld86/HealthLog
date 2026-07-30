/**
 * `GET /api/workouts/{id}` — single-workout detail.
 *
 * v1.4.32 — paired with `GET /api/workouts` so the iOS workout-detail
 * screen + the new `/insights/workouts/[id]` web page consume one
 * canonical envelope per workout. The endpoint:
 *
 *   - Returns the canonical row when the requested id wins its
 *     `(startedAt slot, sportType)` cluster against the user's
 *     source-priority ladder. The picker reuses
 *     `pickCanonicalWorkoutRows()` from v1.4.30 so the dedup contract
 *     stays in sync with the list endpoint.
 *   - When the requested id is a non-canonical twin (e.g. the user
 *     opened a deep-link to a Withings row but the cluster's winner is
 *     Apple Health), the response still resolves the requested row
 *     directly and exposes `canonicalId` pointing at the cluster
 *     winner. The web detail page can redirect via that field; the iOS
 *     client may surface it inline.
 *   - Loads the optional `WorkoutRoute` GeoJSON LineString when
 *     present. Absent for Withings-sourced workouts (Withings ships no
 *     route geometry); absent for manual entries.
 *   - Ownership-gated: a row owned by another user resolves as 404 so
 *     the existence channel never leaks.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { pickCanonicalWorkoutRows } from "@/lib/measurements/pick-canonical-workout-rows";
import { isModuleEnabled, requireModuleEnabled } from "@/lib/modules/gate";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { buildWorkoutHrSeries } from "@/lib/workouts/hr-series";
import {
  computeZones,
  hrMaxFromAge,
  parseWhoopZoneDurations,
} from "@/lib/workouts/zones";
import { computeSplits } from "@/lib/workouts/splits";
import { buildSportContext } from "@/lib/workouts/sport-context";
import type { RouteCoordinate } from "@/lib/workouts/route-svg";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;
    // Web always sends `compact=1` to drop the raw 30k-sample / route
    // timestamp blobs. Absent the param the response is byte-identical to
    // the v1.4.32 contract → iOS is untouched, no coordination ticket.
    const compact = request.nextUrl.searchParams.get("compact") === "1";

    annotate({ action: { name: "workouts.detail" }, meta: { workoutId: id } });

    // v1.18.0 B1 — gate the detail surface behind the workouts module.
    const gate = await requireModuleEnabled(user.id, "workouts");
    if (!gate.enabled) return gate.response;
    const insightsEnabled = await isModuleEnabled(user.id, "insights");

    const row = await prisma.workout.findUnique({
      where: { id },
      include: {
        route: {
          select: {
            id: true,
            geometry: true,
            sampleTimestamps: true,
            createdAt: true,
          },
        },
        samples: {
          select: {
            samples: true,
            sampleCount: true,
          },
        },
        insight: insightsEnabled
          ? {
              select: { paragraphEncrypted: true, generatedAt: true },
            }
          : false,
      },
    });

    // Cross-user 404 guard. The user can only fetch rows they own; any
    // other id surfaces as "not found" so the existence channel stays
    // sealed.
    if (!row || row.userId !== user.id) {
      return apiError("Workout not found", 404);
    }

    // Resolve the canonical winner for the row's cluster. The picker
    // reads every workout in the same 5-minute slot and sport-type
    // bucket; in practice that's ≤ 4 rows (Apple + Withings + the two
    // legacy sources). The query is bounded so the round-trip is cheap.
    const slotMs = 5 * 60 * 1000;
    const slotStart = new Date(
      Math.floor(row.startedAt.getTime() / slotMs) * slotMs,
    );
    const slotEnd = new Date(slotStart.getTime() + slotMs);

    const clusterRows = await prisma.workout.findMany({
      where: {
        userId: user.id,
        sportType: row.sportType,
        startedAt: { gte: slotStart, lt: slotEnd },
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        source: true,
        startedAt: true,
        sportType: true,
        // Part of the canonical session identity consulted by
        // `pickCanonicalWorkoutRows` below — without it a HealthKit re-send of
        // this very workout stays in the cluster and the deep link can resolve
        // to the duplicate instead of the row the list shows.
        durationSec: true,
        avgHeartRate: true,
        maxHeartRate: true,
        metadata: true,
      },
    });

    const userRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { sourcePriorityJson: true, dateOfBirth: true },
    });
    const canonicalCluster = pickCanonicalWorkoutRows(
      clusterRows,
      userRow?.sourcePriorityJson ?? null,
    );
    // The canonical pick may carry multiple rows (same winning source);
    // pick the closest in time to the requested row so deep-link
    // redirects land on the most similar twin.
    const canonical =
      canonicalCluster.find((c) => c.id === row.id) ??
      canonicalCluster[0] ??
      null;
    const effectiveAvgHeartRate = canonical?.avgHeartRate ?? row.avgHeartRate;
    const effectiveMaxHeartRate = canonical?.maxHeartRate ?? row.maxHeartRate;

    // ── Enrichment reads (all over existing tables — no migration) ────

    // Heart-rate curve: stored series first, pulse-window fallback
    // second, hide third. One server path, one DTO with provenance.
    const hrSeries = await buildWorkoutHrSeries({
      userId: user.id,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSec: row.durationSec,
      storedSamples: row.samples?.samples ?? null,
    });
    annotate({
      action: { name: "workouts.detail.hr_series" },
      meta: {
        source: hrSeries?.source ?? "none",
        points: hrSeries?.points.length ?? 0,
      },
    });

    // Effort zones: WHOOP device durations win; else %HRmax fold from
    // the series when profile age exists; else null.
    const ageYears = getAgeFromDateOfBirth(userRow?.dateOfBirth ?? null);
    const zones = computeZones({
      hrMax: hrMaxFromAge(ageYears),
      series: hrSeries?.points ?? [],
      bucketSec: hrSeries?.bucketSec ?? 0,
      whoopZoneDurations: parseWhoopZoneDurations(
        canonical?.metadata ?? row.metadata,
      ),
    });

    // Per-km splits computed server-side from the geometry + timestamps
    // so the web client keeps dropping the raw timestamp blob under
    // `compact=1` while still rendering splits (server-authoritative
    // parity — iOS gets the same resolved figures).
    const geometryCoords =
      row.route &&
      row.route.geometry &&
      typeof row.route.geometry === "object" &&
      Array.isArray(
        (row.route.geometry as { coordinates?: unknown }).coordinates,
      )
        ? (row.route.geometry as { coordinates: RouteCoordinate[] }).coordinates
        : null;
    const splits =
      geometryCoords && Array.isArray(row.route?.sampleTimestamps)
        ? computeSplits(geometryCoords, row.route.sampleTimestamps as string[])
        : null;

    // Sport context: the user's own last-180-days average for this
    // sport, cross-source-collapsed so twins don't double-count.
    const sportContext = await buildSportContext(
      user.id,
      row.sportType,
      userRow?.sourcePriorityJson ?? null,
      row.id,
    );

    const route = row.route
      ? {
          geometry: row.route.geometry,
          // `compact=1` drops the (up to 20k-entry) timestamp array; the
          // SVG needs geometry, not the per-sample timestamps, and the
          // splits above are already derived from them server-side.
          sampleTimestamps: compact
            ? null
            : (row.route.sampleTimestamps ?? null),
        }
      : null;

    // v1.10.0 — route-independent per-workout HR series. Present for
    // both indoor (no route) and outdoor workouts that shipped a
    // `samples` array on ingest; null otherwise. `compact=1` keeps the
    // denormalised count but drops the raw sample blob (the web curve
    // reads `hrSeries` instead).
    const samples = row.samples
      ? {
          sampleCount: row.samples.sampleCount,
          samples: compact ? null : row.samples.samples,
        }
      : null;

    // Decrypt the stored paragraph. Fail-SOFT here and only here: `decrypt` is
    // fail-closed by design, so a rotated-away key would otherwise turn the
    // whole workout-detail page into a 500 over a garnish field. An
    // undecryptable paragraph degrades to no card, exactly like a workout that
    // never had one.
    let aiInsight: { paragraph: string; generatedAt: string } | null = null;
    if (insightsEnabled && row.insight) {
      try {
        aiInsight = {
          paragraph: decryptFromBytes(row.insight.paragraphEncrypted),
          generatedAt: row.insight.generatedAt.toISOString(),
        };
      } catch {
        annotate({
          action: { name: "workouts.detail.insight_undecryptable" },
          meta: { workoutId: row.id },
        });
      }
    }

    return apiSuccess({
      id: row.id,
      sportType: row.sportType,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSec: row.durationSec,
      distanceM: row.totalDistanceM,
      activeEnergyKcal: row.totalEnergyKcal,
      avgHr: effectiveAvgHeartRate,
      maxHr: effectiveMaxHeartRate,
      minHr: row.minHeartRate,
      stepCount: row.stepCount,
      elevationM: row.elevationM,
      pauseDurationSec: row.pauseDurationSec,
      source: row.source,
      externalId: row.externalId,
      metadata: row.metadata,
      route,
      samples,
      // #67 enrichment — all additive, all over existing tables.
      hrSeries,
      zones,
      splits,
      sportContext,
      // The per-workout Activity Insight. A pure READ of a row the
      // `workout-insight-generate` worker wrote when this workout landed —
      // this route never generates, never enqueues, and never falls back to
      // a provider. A workout with no row (every historical one, every
      // re-synced one, every one on a provider-less install) serves null and
      // the page's `{aiInsight ? <card/> : null}` renders nothing.
      aiInsight,
      // v1.4.32 — when the requested id is a non-canonical twin the
      // caller can redirect to `canonicalId` to land on the cluster
      // winner. `canonicalId === id` when the requested row already
      // is the winner.
      canonicalId: canonical?.id ?? row.id,
    });
  },
);
