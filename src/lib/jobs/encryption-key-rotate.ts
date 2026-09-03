/**
 * v1.23 — admin-triggered encryption-key rotation, on pg-boss.
 *
 * Re-encrypts every registered encrypted column to the configured ACTIVE key
 * id, reusing the canonical column registry via `rotateCorpus()`. This is the
 * in-app convenience the admin panel triggers; the CLI
 * (`scripts/rotate-encryption-key.ts`) remains the documented canonical path.
 * pg-boss is the right home because the standalone production image strips
 * `tsx`, so a button that ran the CLI inside the container would fail.
 *
 * SAFETY (security-review surface):
 *  - ACTIVE-KEY-ONLY + NEVER ADDS / DROPS A KEY: `rotateCorpus()` only ever
 *    writes the active key and never touches the env key map. Dropping a key
 *    stays an operator env + redeploy act.
 *  - IDEMPOTENT: rows already on the active key are skipped, so re-running (or
 *    the singleton coalescing a duplicate trigger) re-encrypts nothing.
 *  - FAIL-CLOSED per row: a row under a no-longer-configured key is counted as
 *    an error and left untouched, never dropped.
 *
 * On-demand only — no cron. The admin POST enqueues with a fixed singletonKey
 * so two concurrent triggers collapse into one run. Completion is recorded both
 * as a background wide-event and an `admin.encryption.rotate.completed` audit
 * entry that the status view reads to show the last run.
 */
import { type Job } from "pg-boss";
import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { auditLog } from "@/lib/auth/audit";
import {
  rotateCorpus,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import { getWorkerPrisma } from "@/lib/jobs/reminder/shared";

export const ENCRYPTION_KEY_ROTATE_QUEUE = "encryption-key-rotate";
export const ENCRYPTION_KEY_ROTATE_CONCURRENCY = 1;
/** Fixed key so duplicate admin triggers coalesce into one queued run. */
export const ENCRYPTION_KEY_ROTATE_SINGLETON = "encryption-key-rotate";

export interface EncryptionKeyRotatePayload {
  /** The admin who triggered the run (for the audit trail). */
  requestedByUserId?: string;
  enqueuedAt?: string;
}

export async function runEncryptionKeyRotation(): Promise<{
  activeKeyId: string;
  totalScanned: number;
  totalRotated: number;
  totalErrors: number;
  totalDropped: number;
}> {
  const prisma = getWorkerPrisma();
  const out = await rotateCorpus(prisma as unknown as CorpusClient);
  return {
    activeKeyId: out.activeKeyId,
    totalScanned: out.totalScanned,
    totalRotated: out.totalRotated,
    totalErrors: out.totalErrors,
    totalDropped: out.totalDropped,
  };
}

export async function handleEncryptionKeyRotate(
  jobs: Job<EncryptionKeyRotatePayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.encryption_key_rotate", async (evt) => {
    const requestedBy = jobs[0]?.data?.requestedByUserId ?? null;
    try {
      const result = await runEncryptionKeyRotation();
      evt.addMeta("rotate_active_key_id", result.activeKeyId);
      evt.addMeta("rotate_scanned", result.totalScanned);
      evt.addMeta("rotate_rotated", result.totalRotated);
      evt.addMeta("rotate_errors", result.totalErrors);
      evt.addMeta("rotate_dropped", result.totalDropped);
      await auditLog("admin.encryption.rotate.completed", {
        userId: requestedBy,
        details: {
          activeKeyId: result.activeKeyId,
          scanned: result.totalScanned,
          rotated: result.totalRotated,
          errors: result.totalErrors,
          dropped: result.totalDropped,
        },
      });
      // Per-row errors are the fail-closed skip of a row under a key the
      // deployment no longer configures. The pass still ran, so they ride out
      // as a count rather than failing (and retrying) the whole corpus.
      return jobDone({
        rotate_scanned: result.totalScanned,
        rotate_rotated: result.totalRotated,
        rotate_errors: result.totalErrors,
        rotate_dropped: result.totalDropped,
      });
    } catch (err) {
      evt.addWarning(`encryption-key-rotate failed: ${err}`);
      await auditLog("admin.encryption.rotate.failed", {
        userId: requestedBy,
        details: { message: err instanceof Error ? err.message : String(err) },
      });
      // Re-throw so pg-boss records the failure (the run is idempotent, so a
      // retry is safe).
      throw err;
    }
  });
}
