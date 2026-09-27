/**
 * The restore job's expiry must not be what refuses a plausible account.
 *
 * `restoreBackup` refuses, before deleting anything, a file whose transaction
 * limit would run past the job's budget (three quarters of the pg-boss
 * expiry). At two hours that refused a same-size replacement of about four
 * million readings, a record a long-running Apple Health sync reaches. The
 * expiry is sized so ten million readings over ten million still fit; the
 * expiry is only the backstop for a dead worker, which the heartbeat sweep
 * notices within minutes.
 */
import { describe, expect, it } from "vitest";

import { BACKUP_RESTORE_EXPIRE_SECONDS } from "@/lib/jobs/backup-restore";
import { JOB_BUDGET_SHARE } from "@/lib/jobs/job-budget";
import {
  RESTORE_AFTER_TRANSACTION_ALLOWANCE_MS,
  restoreTransactionTimeoutMs,
} from "@/lib/export/restore-backup";

describe("restore job budget", () => {
  it("admits ten million readings replacing ten million", () => {
    const budgetMs = BACKUP_RESTORE_EXPIRE_SECONDS * 1000 * JOB_BUDGET_SHARE;
    const needed =
      restoreTransactionTimeoutMs(10_000_000, 10_000_000) +
      RESTORE_AFTER_TRANSACTION_ALLOWANCE_MS;
    expect(needed).toBeLessThan(budgetMs);
  });

  it("stays inside pg-boss's own expiry ceiling", () => {
    // pg-boss refuses an expiry of 24 hours or more at send time.
    expect(BACKUP_RESTORE_EXPIRE_SECONDS).toBeLessThan(24 * 60 * 60);
  });
});
