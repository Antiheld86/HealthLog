/**
 * v1.17.0 (F4) — Polar AccessLink sync.
 *
 * Pulls Nightly Recharge (→ RECOVERY_SCORE / ANS_CHARGE / HRV / RHR /
 * respiratory rate), sleep (per-stage durations on a reconstructed END-instant
 * timeline + sleep score), daily activity (steps + active energy + distance),
 * Training Load Pro (→ CARDIO_LOAD), and SpO2 (→ OXYGEN_SATURATION) for one
 * connected user, mapping each into `Measurement` rows tagged `source = POLAR`.
 *
 * Token model: Polar tokens do not expire and have no refresh path, so there is
 * no `getValidToken` refresh dance (the WHOOP shape). A revoked grant surfaces
 * as a 401 → `reauth_required` on the shared integration ledger (`polar` key),
 * exactly like Nightscout's token-rejected path.
 *
 * Idempotency: each row's `externalId` is `<date>:<fieldTag>`. The shared
 * reconciler protects both external and natural identity. Polar re-scores a
 * night for a short window after the fact, so an exact re-post overwrites in
 * place (WHOOP-style re-score), not first-write-wins.
 *
 * The measurement-write tail (per-row upsert → rollup fold → status-insight
 * invalidate) mirrors the shared WHOOP / Nightscout sync tail; it is NOT a new
 * write path.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import {
  markSyncFailureRecorded,
  recordSyncFailure,
  recordSyncSuccess,
  toFailureKind,
  type FailureKind,
} from "@/lib/integrations/status";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import {
  emitInsertedMeasurementArrivals,
  type InsertedMeasurementArrivalRow,
} from "@/lib/arrivals/measurement-emit";
import {
  MeasurementReconciliationError,
  reconcileExternalMeasurement,
} from "@/lib/measurements/reconcile-external-measurement";
import {
  fetchActivities,
  fetchCardioLoads,
  fetchNightlyRecharges,
  fetchSleeps,
  fetchSpo2,
  mapActivity,
  mapCardioLoad,
  mapNightlyRecharge,
  mapSleep,
  mapSpo2,
  type MappedMeasurement,
} from "./client";
import {
  sweepStaleSleepSegments,
  type SleepSegmentSweep,
} from "@/lib/sleep/sweep-stale-segments";
import { getPolarConnection } from "./credentials";
import { PolarApiError, classifyPolarError } from "./response-classifier";

/** Map a Polar error onto the shared integration-ledger failure kind. */
export function classifyPolarFailure(err: unknown): FailureKind {
  return toFailureKind(classifyPolarError(err));
}

/**
 * Record a Polar vitals-leg sync failure on the shared `polar` ledger with the
 * correct classification + HTTP code. Extracted so the poll-cohort boundary can
 * record a future escape with the SAME provider-owned classification the inline
 * catch already applies.
 */
export async function recordPolarSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  await recordSyncFailure({
    userId,
    integration: "polar",
    kind: classifyPolarFailure(err),
    message: err instanceof Error ? err.message : String(err),
    errorCode:
      err instanceof PolarApiError && err.httpStatus != null
        ? String(err.httpStatus)
        : undefined,
  });
}

/** One mapped reading with its `externalId` resolved. */
export interface PolarMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED" | null;
}

function toUpsert(
  mapped: MappedMeasurement[],
  resourcePrefix: string,
): PolarMeasurementUpsert[] {
  return mapped.map((m) => ({
    type: m.type,
    value: m.value,
    unit: m.unit,
    measuredAt: m.measuredAt,
    // Reconstructed sleep segments supply their own indexed externalId so the
    // several rows of one night stay distinct; everything else keys on
    // `<resource>:<date>:<fieldTag>` — stable across re-syncs of the same day.
    // The date is read off `measuredAt` for untimed rows (midnight-UTC
    // anchored), so a mapper-supplied externalId is honoured verbatim to avoid
    // the timed sleep instants drifting the date slice.
    externalId:
      m.externalId ??
      `${resourcePrefix}:${m.measuredAt.toISOString().slice(0, 10)}:${m.fieldTag}`,
    sleepStage: m.sleepStage ?? null,
  }));
}

/**
 * Sync one user's Polar data. Returns the count of measurement rows written.
 * A user with no Polar connection is a clean no-op (returns 0, touches no
 * status row).
 */
export async function syncUserPolar(userId: string): Promise<number> {
  const conn = await getPolarConnection(userId);
  if (!conn) return 0;

  const readings: PolarMeasurementUpsert[] = [];
  const sleepSweeps: SleepSegmentSweep[] = [];
  try {
    const [recharges, sleeps, activities, cardioLoads, spo2Tests] =
      await Promise.all([
        fetchNightlyRecharges(conn.accessToken),
        fetchSleeps(conn.accessToken),
        fetchActivities(conn.accessToken),
        fetchCardioLoads(conn.accessToken),
        fetchSpo2(conn.accessToken),
      ]);
    for (const r of recharges) {
      readings.push(...toUpsert(mapNightlyRecharge(r), "recharge"));
    }
    for (const s of sleeps) {
      const rows = toUpsert(mapSleep(s), "sleep");
      readings.push(...rows);
      // Night-scoped sweep entry: the reconstructed segments of this date all
      // key under `sleep:<date>:seg:` (mapper-supplied). Any live row under
      // that prefix this fetch did NOT re-produce is a re-score orphan or a
      // legacy `:seg:<tag>:<i>` indexed row — tombstoned before the upsert.
      // The prefix deliberately stays on `:seg:` — the IN_BED envelope keys
      // on its measuredAt's UTC date, which can drift a calendar day from
      // `s.date`, so a broader `sleep:<date>:` bound could cross nights.
      sleepSweeps.push({
        prefix: `sleep:${s.date}:seg:`,
        keepIds: rows
          .filter((r) => r.type === "SLEEP_DURATION")
          .map((r) => r.externalId),
      });
    }
    for (const a of activities) {
      readings.push(...toUpsert(mapActivity(a), "activity"));
    }
    for (const c of cardioLoads) {
      readings.push(...toUpsert(mapCardioLoad(c), "cardioload"));
    }
    for (const t of spo2Tests) {
      readings.push(...toUpsert(mapSpo2(t), "spo2"));
    }
  } catch (err) {
    // Recorded here, then marked so the poll-cohort boundary does not
    // double-record it when the legs wrapper rethrows it there.
    await recordPolarSyncFailure(userId, err);
    throw markSyncFailureRecorded(err);
  }

  // Clear whatever an earlier scoring left under the re-fetched nights before
  // the fresh set upserts (mirrors Google Health's replace-by-window order).
  // Best-effort inside the helper — a sweep failure never fails the sync.
  await sweepStaleSleepSegments(userId, "POLAR", sleepSweeps);

  let insertedSleepMeasuredAts: Date[] = [];
  const imported = await upsertPolarMeasurements(userId, readings, {
    onInserted: (rows) => {
      insertedSleepMeasuredAts = rows
        .filter((row) => row.type === "SLEEP_DURATION")
        .map((row) => row.measuredAt);
    },
  });

  // S4 — trigger the debounced morning refresh on a last-night segment landing
  // (mirrors the Withings / WHOOP / Apple seams).
  void maybeEnqueueMorningRefresh(userId, insertedSleepMeasuredAts).catch(
    () => {},
  );

  await recordSyncSuccess(userId, "polar");
  return imported;
}

/**
 * Upsert a batch of mapped Polar readings, then fold the rollup tier +
 * invalidate status-insight caches once at the end (mirrors the WHOOP /
 * Nightscout sync tail). The shared reconciler protects both external and
 * natural identity; an exact re-post overwrites in place. Best-effort on the
 * rollup fold.
 */
export async function upsertPolarMeasurements(
  userId: string,
  readings: PolarMeasurementUpsert[],
  opts: {
    onInserted?: (rows: InsertedMeasurementArrivalRow[]) => void;
  } = {},
): Promise<number> {
  if (readings.length === 0) return 0;

  let imported = 0;
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  const insertedRows: Array<
    InsertedMeasurementArrivalRow & { externalId: string | null }
  > = [];

  const verdicts = await prisma.$transaction(
    async (tx) => {
      const outcomes = [];
      for (const r of readings) {
        const verdict = await reconcileExternalMeasurement(
          tx,
          {
            userId,
            type: r.type as MeasurementType,
            source: "POLAR",
            value: r.value,
            unit: r.unit,
            measuredAt: r.measuredAt,
            externalId: r.externalId,
            sleepStage: r.sleepStage ?? null,
          },
          { exactExternalMatch: "update" },
        );
        if (verdict.status === "failed") {
          throw new MeasurementReconciliationError(verdict);
        }
        outcomes.push(verdict);
      }
      return outcomes;
    },
    { timeout: 60_000 },
  );

  for (let index = 0; index < readings.length; index++) {
    const reading = readings[index]!;
    const verdict = verdicts[index]!;
    for (const dirty of verdict.dirtyIdentities ?? []) {
      touched.push(dirty);
    }
    const type = reading.type as MeasurementType;
    imported++;
    touched.push({ type, measuredAt: reading.measuredAt });
    if (verdict.status === "inserted") {
      insertedRows.push(verdict.row);
    }
  }

  opts.onInserted?.(insertedRows);
  void emitInsertedMeasurementArrivals(userId, insertedRows, "polar").catch(
    () => {},
  );
  try {
    const keys = collapseToTypeDayKeys(touched);
    for (const k of keys) {
      await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
    }
    invalidateStatusInsightsForTypes(
      userId,
      keys.map((k) => k.type),
    ).catch((err) => {
      getEvent()?.addWarning(
        `polar: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(
      `polar: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  return imported;
}
