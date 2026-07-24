/**
 * v1.17.0 (F4) — Polar poll-cohort sync handler.
 * v1.32.15 — the per-user arm now runs BOTH Polar legs: vitals
 * (`syncUserPolar`) then exercises/workouts (`syncUserPolarWorkouts`).
 *
 * Poll-only: Polar AccessLink has a webhook, but HealthLog runs the simpler
 * poll model (matching Nightscout). One hourly cron tick carries no `userId`
 * and the handler iterates every user with a stored Polar token, re-syncing
 * each via `syncUserPolarLegs`. One user's revoked grant / outage is warned and
 * the pass continues. The shared control flow lives in `./poll-cohort`.
 *
 * The queue name, cron schedule, and boss.work registration live in
 * reminder-worker.ts — no new queue: the workout leg rides the existing hourly
 * `polar-sync` tick (one extra request per connected user per hour).
 */
import { recordPolarSyncFailure, syncUserPolar } from "@/lib/polar/sync";
import { syncUserPolarWorkouts } from "@/lib/polar/sync-workouts";
import { makePollCohortHandler, type PollCohortPayload } from "./poll-cohort";

export type PolarSyncPayload = PollCohortPayload;

/**
 * Run both Polar legs for one user with INDEPENDENT attribution on the shared
 * `polar` ledger. Sequentially awaited (not `Promise.all`) so a workouts error
 * stays attributable. Each leg records its own failure; the vitals leg owns the
 * single success write. A failure in either leg is isolated — both legs are
 * always attempted, so a workouts-leg failure can never mask a vitals success
 * and vice versa — then the FIRST error is rethrown so the cohort handler warns
 * and skips this user's success accounting without losing the error.
 *
 * The vitals leg (`syncUserPolar`) now settles its five collections
 * independently: a fetch/map failure on one collection is recorded as a partial
 * failure and the leg RETURNS (no rethrow, no success stamp), importing the
 * healthy collections. So the vitals leg reaching this wrapper's catch means a
 * write-path/unexpected error, not a collection fetch failure.
 */
export async function syncUserPolarLegs(userId: string): Promise<number> {
  let total = 0;
  let firstError: unknown;
  let hadError = false;

  try {
    total += await syncUserPolar(userId);
  } catch (err) {
    firstError = err;
    hadError = true;
  }

  try {
    total += await syncUserPolarWorkouts(userId);
  } catch (err) {
    if (!hadError) {
      firstError = err;
      hadError = true;
    }
  }

  if (hadError) throw firstError;
  return total;
}

export const handlePolarSync = makePollCohortHandler({
  taskName: "job.polar_sync",
  findCohort: async (prisma) => {
    const users = await prisma.user.findMany({
      where: { polarAccessTokenEncrypted: { not: null } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  },
  syncUser: syncUserPolarLegs,
  // Catches an UNMARKED escape — the `upsertPolarMeasurements` /
  // `upsertPolarWorkouts` write-path throw. The vitals leg records its own
  // per-collection partial failures inline and returns without rethrowing; the
  // workouts leg records + marks its own fetch failures. Only an unmarked
  // write-path/unexpected escape reaches this boundary recorder.
  recordFailure: recordPolarSyncFailure,
});
