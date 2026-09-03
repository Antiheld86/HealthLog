/**
 * Weekly on-host data backup and the nightly off-host backup handler.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { recordError } from "@/lib/jobs/worker-status";
import { packBackupBlobStreaming } from "@/lib/export/backup-blob";
import {
  BackupHeapBudgetExceededError,
  streamFullBackupJson,
} from "@/lib/export/full-backup-stream";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import {
  OffhostBackupNotConfiguredError,
  runOffhostBackup,
} from "@/lib/jobs/offhost-backup";
import { getWorkerPrisma } from "./shared";

export interface DataBackupPayload {
  triggeredAt: string;
}

export interface OffhostBackupPayload {
  triggeredAt: string;
}

export async function handleOffhostBackup(
  jobs: Job<OffhostBackupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.offhost_backup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const report = await runOffhostBackup(p);
      evt.addMeta("offhost_backup_uploaded", report.uploaded);
      evt.addMeta("offhost_backup_failed", report.failed);
      evt.addMeta("offhost_backup_total_users", report.totalUsers);
      evt.addMeta("offhost_backup_endpoint", report.config.endpoint);
      evt.addMeta("offhost_backup_bucket", report.config.bucket);
      // Per-user failure detail is also emitted as warnings inside
      // runOffhostBackup; echo a structured digest for at-a-glance triage.
      if (report.failures.length > 0) {
        evt.addMeta(
          "offhost_backup_failures",
          JSON.stringify(report.failures.slice(0, 10)),
        );
      }
      // Per-user upload failures ride out as `offhost_backup_failed`: the run
      // itself uploaded what it could, and failing the queue over one user's
      // object would re-upload the whole cohort on every retry.
      return jobDone({
        offhost_backup_uploaded: report.uploaded,
        offhost_backup_failed: report.failed,
        offhost_backup_total_users: report.totalUsers,
      });
    } catch (err) {
      // Not configured ⇒ skip silently with a warning, not an error: most
      // self-hosts never set the S3 credentials, and a nightly failed job on
      // every one of them buries the runs that genuinely could not upload.
      evt.addWarning(`offhost-backup skipped/failed: ${err}`);
      if (err instanceof OffhostBackupNotConfiguredError) {
        return jobDone({ offhost_backup_configured: false });
      }
      return jobFailed("offhost backup failed", err);
    }
  });
}

export async function handleDataBackup(
  jobs: Job<DataBackupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.data_backup", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const users = await prisma.user.findMany({
        select: { id: true, username: true },
      });

      let backed = 0;
      let usersFailed = 0;
      let heapBudgetTrips = 0;
      let largestBlobBytes = 0;
      for (const user of users) {
        try {
          // Streamed, compressed, then encrypted (the record contains
          // sensitive health information). Nothing between the database rows
          // and this string exists as a whole: the payload goes into gzip a
          // page at a time and the cipher consumes gzip's output as it comes,
          // because a materialised copy of a large record is what used to take
          // the process down. Both legs live in `packBackupBlobStreaming`,
          // which is also what the restore path reads back through.
          const encryptedBackup = await packBackupBlobStreaming((write) =>
            streamFullBackupJson(prisma, user.id, write, {
              purpose: "disaster-recovery",
            }),
          );
          largestBlobBytes = Math.max(
            largestBlobBytes,
            Buffer.byteLength(encryptedBackup, "utf8"),
          );

          await prisma.dataBackup.upsert({
            where: {
              userId_type: { userId: user.id, type: "WEEKLY_AUTO" },
            },
            update: {
              data: encryptedBackup,
              createdAt: new Date(),
            },
            create: {
              userId: user.id,
              type: "WEEKLY_AUTO",
              data: encryptedBackup,
            },
          });
          backed++;
        } catch (err) {
          // One user's payload failing is that user's problem, not the pass's:
          // it rides out as a count so the weekly run is not retried for the
          // whole cohort.
          //
          // A record too large for this container's heap lands here too, and
          // that is the whole point of the budget the writer enforces: before
          // it existed the same condition was an uncatchable V8 abort that
          // restarted the instance, so one account's size was a denial of
          // service on every other account on the host.
          usersFailed++;
          if (err instanceof BackupHeapBudgetExceededError) heapBudgetTrips++;
          evt.addWarning(`Failed for user ${user.id}: ${err}`);
        }
      }

      // The stored size is the one number that says whether this pass is
      // heading back towards the wall it hit before: it tracks the record.
      evt.addMeta("data_backup_largest_blob_bytes", largestBlobBytes);
      // How many accounts the writer stopped rather than let the process die.
      // Non-zero means this host needs more memory, not a retry.
      evt.addMeta("data_backup_heap_budget_trips", heapBudgetTrips);
      evt.setBackground({
        task_name: "job.data_backup",
        result: { backed, total: users.length },
      });
      return jobDone({
        backed,
        total: users.length,
        users_failed: usersFailed,
        heap_budget_trips: heapBudgetTrips,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}
