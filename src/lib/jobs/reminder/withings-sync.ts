/**
 * Withings fallback measure sync plus the hourly activity / sleep v2 sync handlers.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { recordError, recordWithingsSync } from "@/lib/jobs/worker-status";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import {
  retryDueWithingsWebhookSubscriptions,
  syncUserMeasurements,
} from "@/lib/withings/sync";
import { syncUserActivity } from "@/lib/withings/sync-activity";
import { syncUserSleep } from "@/lib/withings/sync-sleep";
import { syncUserEcg } from "@/lib/withings/sync-ecg";
import type { WithingsEcgSyncPayload } from "@/lib/jobs/withings-ecg-queue";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { getWorkerPrisma } from "./shared";
export type { WithingsEcgSyncPayload } from "@/lib/jobs/withings-ecg-queue";

export interface WithingsSyncPayload {
  triggeredAt: string;
}

/**
 * v1.4.25 W17b — payload for the activity-sync queue. When enqueued
 * by the webhook handler, `userId` is set so the worker syncs only
 * that user; when enqueued by the cron schedule, `userId` is absent
 * and the worker iterates every connection (safety-net behaviour).
 */
export interface WithingsActivitySyncPayload {
  triggeredAt: string;
  userId?: string;
}

/**
 * v1.4.25 W17c — payload for the sleep-sync queue. Same shape and
 * webhook-vs-cron semantics as the activity payload.
 */
export interface WithingsSleepSyncPayload {
  triggeredAt: string;
  userId?: string;
}

/**
 * Fallback polling for Withings data.
 * Runs periodically in case webhook delivery is delayed or unavailable.
 */
export async function handleWithingsFallbackSync(
  jobs: Job<WithingsSyncPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.withings_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      recordWithingsSync();
      // The subscription repair is an auxiliary leg, not the pass this queue is
      // named for. Failing the job on it would skip the fallback sync that every
      // user relies on when a webhook goes missing, so it rides out as a fact.
      let subscriptionRepairFailed = false;
      try {
        await retryDueWithingsWebhookSubscriptions();
      } catch {
        subscriptionRepairFailed = true;
        evt.addWarning(
          "Withings subscription repair failed; continuing fallback sync",
        );
      }
      const connections = await prisma.withingsConnection.findMany({
        select: { userId: true },
      });

      if (connections.length === 0) {
        return jobDone({
          total: 0,
          users_synced: 0,
          users_failed: 0,
          measurements_imported: 0,
          subscription_repair_failed: subscriptionRepairFailed,
        });
      }

      let usersSynced = 0;
      let usersFailed = 0;
      let measurementsImported = 0;

      for (const connection of connections) {
        try {
          const imported = await syncUserMeasurements(connection.userId);
          usersSynced++;
          measurementsImported += imported;
          // v1.18.1 — a fresh reading landed; resolve this user's Vorsorge
          // reminders eventfully. Fire-and-forget; the cron is the net.
          if (imported > 0) {
            fireAndForget(enqueueReminderSatisfy(connection.userId), {
              action: "reminder.satisfy.enqueue",
            });
          }
        } catch {
          usersFailed++;
          evt.addWarning(`Fallback sync failed for user ${connection.userId}`);
        }
      }

      evt.setBackground({
        task_name: "job.withings_sync",
        result: {
          users_synced: usersSynced,
          total: connections.length,
          measurements_imported: measurementsImported,
        },
      });
      return jobDone({
        total: connections.length,
        users_synced: usersSynced,
        users_failed: usersFailed,
        measurements_imported: measurementsImported,
        subscription_repair_failed: subscriptionRepairFailed,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * ECG sync handler. Two enqueue paths feed this queue, mirroring the
 * activity / sleep handlers:
 *
 *   1. Webhook (appli=54) — payload carries `userId` (+ the source
 *      `startdate`/`enddate` window); the handler runs `syncUserEcg` for that
 *      one user over the windowed range.
 *   2. Cron (`withings-ecg-sync` at :41) — payload has no `userId`, the handler
 *      iterates every Withings connection and runs `syncUserEcg` over its
 *      default trailing 30-day window. This is the catch-net that lets a
 *      watch-only account (no scale, appli 54 unsubscribed) pull its ECG strips
 *      without a webhook.
 *
 * Per-user failures are warned and the cohort carries on so one user's
 * parked-at-reauth state (or a transient device outage) never starves the rest;
 * the ECG leaf records its own classified failure on the shared `withings`
 * ledger, so honesty is preserved without rejecting the whole batch.
 */
export async function handleWithingsEcgSync(
  jobs: Job<WithingsEcgSyncPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.withings_ecg_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{
        userId: string;
        startdate?: number;
        enddate?: number;
      }> = [];
      for (const job of jobs) {
        if (job.data?.userId) {
          targets.push({
            userId: job.data.userId,
            startdate: job.data.startdate,
            enddate: job.data.enddate,
          });
        }
      }
      // No user-specific enqueue → cron fallback iterating every connection.
      if (targets.length === 0) {
        const connections = await prisma.withingsConnection.findMany({
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) {
        return jobDone({
          total: 0,
          users_synced: 0,
          users_failed: 0,
          recordings_imported: 0,
        });
      }

      let usersSynced = 0;
      let usersFailed = 0;
      let recordingsImported = 0;
      for (const { userId, startdate, enddate } of targets) {
        try {
          const options =
            startdate === undefined && enddate === undefined
              ? {}
              : { startdate, enddate };
          recordingsImported += await syncUserEcg(userId, options);
          usersSynced++;
        } catch (err) {
          usersFailed++;
          evt.addWarning(`Withings ECG sync failed for user ${userId}: ${err}`);
        }
      }

      evt.setBackground({
        task_name: "job.withings_ecg_sync",
        result: {
          users_synced: usersSynced,
          total: targets.length,
          recordings_imported: recordingsImported,
        },
      });
      return jobDone({
        total: targets.length,
        users_synced: usersSynced,
        users_failed: usersFailed,
        recordings_imported: recordingsImported,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.4.25 W17b — activity-sync handler.
 *
 * Two enqueue paths feed this queue:
 *
 *   1. Webhook (appli=16) — payload carries `userId`, the handler
 *      runs `syncUserActivity` for that one user.
 *   2. Cron (`withings-activity-sync` at :00 every hour) — payload
 *      has no `userId`, the handler iterates every Withings
 *      connection and re-syncs each. Catches the 1 % of webhook
 *      deliveries Withings drops.
 *
 * Sync failures per-user are logged as warnings; the queue carries on
 * so one user's parked-at-reauth state doesn't starve every other
 * connection on the cron tick.
 */
export async function handleWithingsActivitySync(
  jobs: Job<WithingsActivitySyncPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.withings_activity_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) {
          targets.push({ userId: job.data.userId });
        }
      }
      // No user-specific enqueue → cron fallback iterating everyone.
      if (targets.length === 0) {
        const connections = await prisma.withingsConnection.findMany({
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

      let usersSynced = 0;
      let usersFailed = 0;
      let measurementsImported = 0;
      for (const { userId } of targets) {
        try {
          const imported = await syncUserActivity(userId);
          usersSynced++;
          measurementsImported += imported;
          if (imported > 0) {
            fireAndForget(enqueueReminderSatisfy(userId), {
              action: "reminder.satisfy.enqueue",
            });
          }
        } catch {
          usersFailed++;
          evt.addWarning(`Withings activity sync failed for user ${userId}`);
        }
      }

      evt.setBackground({
        task_name: "job.withings_activity_sync",
        result: {
          users_synced: usersSynced,
          total: targets.length,
          measurements_imported: measurementsImported,
        },
      });
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

/**
 * v1.4.25 W17c — sleep-sync handler. Same enqueue semantics as the
 * activity handler: per-user when the webhook fires, full-iteration
 * when the cron ticks.
 */
export async function handleWithingsSleepSync(
  jobs: Job<WithingsSleepSyncPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.withings_sleep_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) {
          targets.push({ userId: job.data.userId });
        }
      }
      if (targets.length === 0) {
        const connections = await prisma.withingsConnection.findMany({
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

      let usersSynced = 0;
      let usersFailed = 0;
      let measurementsImported = 0;
      for (const { userId } of targets) {
        try {
          const imported = await syncUserSleep(userId);
          usersSynced++;
          measurementsImported += imported;
          if (imported > 0) {
            fireAndForget(enqueueReminderSatisfy(userId), {
              action: "reminder.satisfy.enqueue",
            });
          }
        } catch {
          usersFailed++;
          evt.addWarning(`Withings sleep sync failed for user ${userId}`);
        }
      }

      evt.setBackground({
        task_name: "job.withings_sleep_sync",
        result: {
          users_synced: usersSynced,
          total: targets.length,
          measurements_imported: measurementsImported,
        },
      });
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
