/**
 * Queue names for the poll-only integration syncs.
 *
 * Split out of `reminder/register-integration-sync.ts` so a request-path caller
 * (an OAuth callback enqueueing the first sync at connect time) can name the
 * queue without importing the registrar — which would drag every worker handler
 * and its transitive graph into the request bundle. Same shape as
 * `STRAVA_BACKFILL_QUEUE`, which the Strava callback already imports from its
 * own module.
 *
 * The registrar remains the single place that creates, schedules, and binds a
 * handler to each of these; the values here are its source. A name declared
 * here but missing from `allQueues` there is the v1.4.37 dead-queue class, and
 * the queue-wiring guards read both files for exactly that reason.
 */

/** Hourly Nightscout CGM poll (:11). */
export const NIGHTSCOUT_SYNC_QUEUE = "nightscout-sync";

/** Hourly Polar AccessLink poll (:13). */
export const POLAR_SYNC_QUEUE = "polar-sync";

/** Hourly Oura Cloud poll (:15). */
export const OURA_SYNC_QUEUE = "oura-sync";

/** Hourly Strava poll (:17). */
export const STRAVA_SYNC_QUEUE = "strava-sync";
