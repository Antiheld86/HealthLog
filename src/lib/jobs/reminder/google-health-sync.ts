/**
 * Google Health hourly poll-cohort sync and OAuth-state cleanup handlers.
 *
 * Extracted alongside the Fitbit handlers; register-integration-sync.ts owns the
 * queue names, cron schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { recordError } from "@/lib/jobs/worker-status";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { runGoogleHealthPollCohort } from "@/lib/google-health/sync";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { cleanupExpiredGoogleHealthOAuthStates } from "@/lib/jobs/google-health-oauth-state-cleanup";
import { getWorkerPrisma } from "./shared";

/**
 * v1.26.0 — Google Health poll-sync payload. Poll-only (no webhook — Pub/Sub is
 * deferred): the single hourly cron tick carries no `userId`, so the handler
 * iterates every Google Health connection and re-syncs each via
 * `syncUserGoogleHealth`. One user's parked-at-reauth state never starves the
 * rest of the cohort.
 */
export interface GoogleHealthSyncPayload {
  userId?: string;
}

export async function handleGoogleHealthSync(
  jobs: Job<GoogleHealthSyncPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.google_health_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) targets.push({ userId: job.data.userId });
      }
      if (targets.length === 0) {
        const connections = await prisma.googleHealthConnection.findMany({
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) {
        return jobDone({
          total: 0,
          users_synced: 0,
          users_failed: 0,
          measurements_imported: 0,
        });
      }

      // Fan the cohort out with bounded concurrency + per-user error isolation:
      // one slow Google response can't stall the whole cohort, and a single
      // user's failure is warned without aborting the pass.
      let usersFailed = 0;
      const { usersSynced, measurementsImported } =
        await runGoogleHealthPollCohort(
          targets.map((t) => t.userId),
          {
            onUserError: (userId, err) => {
              usersFailed++;
              evt.addWarning(
                `job.google_health_sync failed for user ${userId}: ${err}`,
              );
            },
            // A fresh reading landed; resolve the user's Vorsorge reminders
            // eventfully. Fire-and-forget; the cron is the net.
            onUserSynced: (userId, imported) => {
              if (imported > 0) {
                fireAndForget(enqueueReminderSatisfy(userId), {
                  action: "reminder.satisfy.enqueue",
                });
              }
            },
          },
        );

      evt.setBackground({
        task_name: "job.google_health_sync",
        result: {
          users_synced: usersSynced,
          total: targets.length,
          measurements_imported: measurementsImported,
        },
      });
      // The pass is the unit of success: a revoked grant belongs on that user's
      // integration ledger, not in a queue failure that retries every account.
      return jobDone({
        total: targets.length,
        users_synced: usersSynced,
        users_failed: usersFailed,
        measurements_imported: measurementsImported,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

export interface GoogleHealthOAuthStateCleanupPayload {
  triggeredAt?: string;
}

export async function handleGoogleHealthOAuthStateCleanup(
  jobs: Job<GoogleHealthOAuthStateCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent(
    "job.google_health_oauth_state_cleanup",
    async (evt) => {
      const p = getWorkerPrisma();
      try {
        const deleted = await cleanupExpiredGoogleHealthOAuthStates(p);
        evt.addMeta("google_health_oauth_state_cleanup_deleted", deleted);
        return jobDone({ deleted });
      } catch (err) {
        evt.addWarning(`google-health-oauth-state-cleanup failed: ${err}`);
        return jobFailed("google health oauth state cleanup failed", err);
      }
    },
  );
}
