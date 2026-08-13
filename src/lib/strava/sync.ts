/**
 * v1.28.x — Strava API v3 sync.
 *
 * Pulls the athlete's activities and upserts each into the `Workout` table as
 * `source = STRAVA`, keyed on `(userId, source, externalId)` so a re-fetch /
 * `activity.update` overwrites in place. Strava is a WORKOUT source only — it
 * exposes no daily metrics, so unlike the Oura/Polar sync this writes `Workout`
 * rows and stops (no measurement rollup fold).
 *
 * Cross-source dedup is NOT done here: a Strava run and the same run via Apple
 * Health remain two distinct `Workout` rows (different `source`); the read-time
 * `pickCanonicalWorkoutRows` picker collapses the cross-source twin at read
 * time via the user's source-priority ladder. One engine, no parallel path.
 *
 * Token model: Strava ROTATES its refresh token on every refresh. The schema
 * has no expiry column, so the sync refreshes REACTIVELY — the first read that
 * 401s triggers one refresh (persisting BOTH rotated tokens via a compare-and-
 * set) and a single retry. A failed refresh (`invalid_grant`) records
 * `reauth_required` on the `strava` ledger.
 *
 * Rate limits: 200 req / 15 min + 2000 / day per app. The walk is page-bounded
 * and the per-activity detail fetch (for `calories`, absent from the summary)
 * is budget-capped; a 429 mid-walk records a transient failure and the next
 * cron tick resumes from the cursor.
 */
import { prisma } from "@/lib/db";
import { emitInsertedWorkoutArrival } from "@/lib/arrivals/workout-emit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  markSyncFailureRecorded,
  recordSyncFailure,
  recordSyncSuccess,
  toFailureKind,
  type FailureKind,
} from "@/lib/integrations/status";
import {
  fetchActivities,
  fetchActivityById,
  mapActivity,
  refreshAccessToken,
  summaryHasHeartRate,
  type StravaDetailedActivity,
  type StravaWorkoutRow,
} from "./client";
import {
  getStravaClientCredentials,
  getStravaConnection,
  storeStravaTokens,
} from "./credentials";
import { StravaApiError, classifyStravaError } from "./response-classifier";

/** Default first-incremental lookback (days) when no cursor exists yet. */
export const STRAVA_SYNC_LOOKBACK_DAYS = 30;

/** Overlap (ms) subtracted from the stored cursor on an incremental sync so an
 * activity uploaded late (started before the cursor, synced after) is still
 * caught. The upsert is idempotent, so re-fetching the overlap window is cheap. */
export const STRAVA_SYNC_OVERLAP_MS = 24 * 60 * 60 * 1000;

const PER_PAGE = 100;
const INCREMENTAL_MAX_PAGES = 5;
const BACKFILL_MAX_PAGES = 40;
/** Per-activity detail calls (for `calories`) are capped per sync to stay well
 * under Strava's 200-req / 15-min ceiling on a heavy backfill. */
const INCREMENTAL_DETAIL_BUDGET = 100;
const BACKFILL_DETAIL_BUDGET = 150;

export function classifyStravaFailure(err: unknown): FailureKind {
  return toFailureKind(classifyStravaError(err));
}

export async function recordStravaFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  await recordSyncFailure({
    userId,
    integration: "strava",
    kind: classifyStravaFailure(err),
    message: err instanceof Error ? err.message : String(err),
    errorCode:
      err instanceof StravaApiError && err.httpStatus != null
        ? String(err.httpStatus)
        : undefined,
  });
}

export interface SyncUserStravaOptions {
  fullSync?: boolean;
  lookbackDays?: number;
}

/**
 * Sync one user's Strava activities. Returns the count of `Workout` rows
 * written. A user with no Strava connection is a clean no-op (returns 0,
 * touches no status row).
 */
export async function syncUserStrava(
  userId: string,
  opts: SyncUserStravaOptions = {},
): Promise<number> {
  const conn = await getStravaConnection(userId);
  if (!conn) return 0;

  const fullSync = opts.fullSync ?? false;

  // Resolve the incremental cursor. On a full backfill we walk all history
  // (`after` omitted). Otherwise start at the stored newest-activity instant
  // minus the overlap, or a default lookback when no cursor exists yet.
  let afterEpoch: number | undefined;
  if (!fullSync) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stravaLastActivityAt: true },
    });
    const lookbackMs =
      (opts.lookbackDays ?? STRAVA_SYNC_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;
    const base = user?.stravaLastActivityAt
      ? user.stravaLastActivityAt.getTime() - STRAVA_SYNC_OVERLAP_MS
      : Date.now() - lookbackMs;
    afterEpoch = Math.floor(base / 1000);
  }

  // Reactive refresh state — one refresh per sync, shared across every call.
  let accessToken = conn.accessToken;
  let refreshDone = false;

  async function refreshOnce(): Promise<boolean> {
    if (refreshDone) return false;
    const creds = await getStravaClientCredentials(userId);
    if (!creds) return false;
    const rotated = await refreshAccessToken(conn!.refreshToken, creds);
    const usable = await storeStravaTokens(
      userId,
      rotated.access_token,
      rotated.refresh_token,
      conn!.refreshTokenCiphertext,
    );
    if (!usable) return false;
    accessToken = usable;
    refreshDone = true;
    return true;
  }

  async function authed<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(accessToken);
    } catch (err) {
      if (
        err instanceof StravaApiError &&
        err.httpStatus === 401 &&
        (await refreshOnce())
      ) {
        return fn(accessToken);
      }
      throw err;
    }
  }

  const maxPages = fullSync ? BACKFILL_MAX_PAGES : INCREMENTAL_MAX_PAGES;
  let detailBudget = fullSync
    ? BACKFILL_DETAIL_BUDGET
    : INCREMENTAL_DETAIL_BUDGET;

  const rows: StravaWorkoutRow[] = [];
  let newestStart: Date | null = null;

  try {
    for (let page = 1; page <= maxPages; page++) {
      const activities = await authed((t) =>
        fetchActivities(t, { after: afterEpoch, page, perPage: PER_PAGE }),
      );
      if (activities.length === 0) break;

      for (const a of activities) {
        // Fetch detail only to fill `calories` (absent from the summary), and
        // only while the budget allows. When the summary already lacks HR we
        // also let the detail top it up. A detail failure is non-fatal — map
        // from the summary — but a 429 aborts the whole walk (transient).
        let detail: StravaDetailedActivity | null = null;
        if (detailBudget > 0) {
          try {
            detail = await authed((t) => fetchActivityById(t, a.id));
            detailBudget -= 1;
          } catch (err) {
            if (err instanceof StravaApiError && err.httpStatus === 429) {
              throw err;
            }
            getEvent()?.addWarning(
              `strava: activity detail fetch failed for ${a.id}: ${err}`,
            );
            detail = null;
          }
        } else if (!summaryHasHeartRate(a)) {
          getEvent()?.addWarning(
            `strava: detail budget exhausted; mapping activity ${a.id} from summary only`,
          );
        }

        const row = mapActivity(a, detail);
        if (row) {
          rows.push(row);
          if (a.start_date) {
            const d = new Date(a.start_date);
            if (
              !Number.isNaN(d.getTime()) &&
              (!newestStart || d > newestStart)
            ) {
              newestStart = d;
            }
          }
        }
      }

      if (activities.length < PER_PAGE) break;
    }
  } catch (err) {
    await recordStravaFailure(userId, err);
    throw markSyncFailureRecorded(err);
  }

  let imported: number;
  try {
    imported = await upsertStravaWorkouts(userId, rows);

    // Advance the incremental cursor to the newest activity start we saw, but
    // never move it backwards (a bounded backfill page-walk may not reach the
    // very newest activity in one pass).
    if (newestStart) {
      await prisma.user.updateMany({
        where: {
          id: userId,
          OR: [
            { stravaLastActivityAt: null },
            { stravaLastActivityAt: { lt: newestStart } },
          ],
        },
        data: { stravaLastActivityAt: newestStart },
      });
    }
  } catch (err) {
    await recordStravaFailure(userId, err);
    throw markSyncFailureRecorded(err);
  }

  await recordSyncSuccess(userId, "strava");

  // Background-sync posture: sweep the workouts cache and mark the analytics
  // cells stale (workouts feed achievements + analytics) so the upserted rows
  // reach the cached readers, matching the `/api/workouts/batch` writer.
  if (imported > 0) {
    invalidateUserMeasurements(userId);
  }

  annotate({
    action: { name: "strava.sync.complete", details: { imported } },
  });
  return imported;
}

/**
 * Upsert a batch of mapped Strava activities into `Workout`, keyed on
 * `(userId, source = STRAVA, externalId)` so a re-fetch overwrites in place.
 * `(userId, source = STRAVA, externalId)` so replays overwrite in place.
 * Failed rows are logged while the rest of the batch is attempted, then the
 * first error is rethrown so the caller cannot advance its cursor or backfill
 * watermark past a partially persisted batch.
 */
export async function upsertStravaWorkouts(
  userId: string,
  rows: readonly StravaWorkoutRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  let imported = 0;
  let firstError: unknown;
  let hadError = false;
  for (const r of rows) {
    const data = {
      sportType: r.sportType,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationSec: r.durationSec,
      totalEnergyKcal: r.totalEnergyKcal,
      totalDistanceM: r.totalDistanceM,
      avgHeartRate: r.avgHeartRate,
      maxHeartRate: r.maxHeartRate,
      elevationM: r.elevationM,
      metadata: r.metadata,
    };
    try {
      const [inserted] = await prisma.workout.createManyAndReturn({
        data: {
          userId,
          source: "STRAVA",
          externalId: r.externalId,
          ...data,
        },
        skipDuplicates: true,
        select: { id: true, startedAt: true },
      });
      if (inserted) {
        void emitInsertedWorkoutArrival(userId, inserted, "strava").catch(
          () => {},
        );
      } else {
        await prisma.workout.update({
          where: {
            userId_source_externalId: {
              userId,
              source: "STRAVA",
              externalId: r.externalId,
            },
          },
          data,
        });
      }
      imported += 1;
    } catch (err) {
      getEvent()?.addWarning(`strava: failed to upsert workout: ${err}`);
      if (!hadError) {
        firstError = err;
        hadError = true;
      }
    }
  }
  if (hadError) throw firstError;

  annotate({
    action: { name: "strava.workout.ingest", details: { imported } },
  });
  return imported;
}
