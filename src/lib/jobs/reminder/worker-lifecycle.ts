/**
 * Reminder-worker boot lifecycle helpers.
 *
 * These run once per worker process around the queue/schedule/handler wiring
 * in `reminder-worker.ts`: a graceful-shutdown signal binding plus two
 * fire-and-forget boot maintenance passes. None of them touch the pg-boss
 * queue declarations, the `allQueues` array, the `schedules` table, or the
 * `boss.work` bindings — those stay co-located in `reminder-worker.ts` so the
 * source-text registration guards (the v1.4.37 dead-queue catch) keep working.
 */
import type { PgBoss } from "pg-boss";

import { reconcileOrphanImportJobs } from "@/lib/jobs/apple-health-import-worker";
import { probeIntegrationStatusNullBuckets } from "@/lib/jobs/integration-status-null-probe";
import { withBackgroundEvent } from "@/lib/logging/background";

import { getWorkerPrisma, workerLog } from "./shared";

/**
 * Graceful shutdown: drain in-flight jobs on SIGTERM/SIGINT (sent by Docker
 * Compose `docker stop`, Kubernetes pod termination, Coolify redeploys).
 * Without this, pending handlers were force-killed and could either be lost
 * or replayed on next start. The listeners register once — re-entering the
 * worker boot (e.g. on hot-reload in dev) is a no-op for the handlers because
 * they capture `boss` by closure and the first signal stops everything.
 */
export function registerShutdownHandlers(boss: PgBoss): void {
  let shutdownInProgress = false;
  const onSignal = async (signal: "SIGTERM" | "SIGINT") => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    workerLog("error", `received ${signal}, draining boss`);
    try {
      // graceful=true waits for active handlers to finish, then closes the
      // pg connection pool. timeout cap so a stuck handler can't block deploys.
      await boss.stop({ graceful: true, timeout: 30_000 });
    } catch (err) {
      workerLog("error", "boss.stop failed during shutdown", err);
    }
  };
  process.once("SIGTERM", () => void onSignal("SIGTERM"));
  process.once("SIGINT", () => void onSignal("SIGINT"));
}

/**
 * v1.4.34 — reconcile any `ImportJob` rows that were mid-parse when the worker
 * last shut down. Flips orphaned rows to `failed` so the operator can
 * re-upload without leaving the polling endpoint stuck on `parsing` /
 * `upserting`. Never throws.
 */
export async function reconcileImportJobsAtBoot(): Promise<void> {
  try {
    await reconcileOrphanImportJobs();
  } catch (err) {
    workerLog("error", "Failed to reconcile orphan ImportJob rows", err);
  }
}

/**
 * v1.4.48 M1 — boot probe for legacy `integration_statuses` rows that still
 * carry `consecutive_failures_by_kind = NULL`. After v1.4.47 dropped the
 * single-column fallback, such rows alert two strikes later than they did
 * pre-upgrade. The probe is a single count query + Wide-Event warning if any
 * survive; fire-and-forget so a probe failure never blocks worker boot.
 */
export async function probeIntegrationStatusAtBoot(): Promise<void> {
  try {
    await withBackgroundEvent(
      "worker.boot.integration_status_null_probe",
      async () => {
        await probeIntegrationStatusNullBuckets(getWorkerPrisma());
      },
    );
  } catch (err) {
    workerLog("error", "integration-status-null-probe failed", err);
  }
}
