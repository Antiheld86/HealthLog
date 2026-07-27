/**
 * v1.10.0 — computed scores (WX-E). Queue-registration guards for the
 * Stress + Strain nightly score jobs and the dense intra-day retention
 * drain.
 *
 * Same source-text-grep approach as the WX-C recovery-score guard: assert
 * each queue is imported, registered in `allQueues`, scheduled (the two
 * cron-driven score jobs), and wired to a `createAndWork` handler — without
 * booting pg-boss + Prisma. An unregistered queue silently never drains
 * (the recurring past bug this guards against).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the queue wiring moved out of the 2143-LOC reminder-worker boot
// file into domain registrars. Stress + Strain live in the status registrar;
// the dense intra-day retention queue (and the nightly fold onto the
// drain-cumulative tick) lives in the rollup registrar. Concatenate both so the
// dead-queue guard follows the wiring into each.
const STATUS_REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-status.ts",
);
const ROLLUP_REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-rollup.ts",
);
const source =
  readFileSync(STATUS_REGISTRAR_PATH, "utf8") +
  readFileSync(ROLLUP_REGISTRAR_PATH, "utf8");

const DENSE_RETENTION_PATH = join(
  __dirname,
  "..",
  "dense-intraday-retention.ts",
);
const denseRetentionSource = readFileSync(DENSE_RETENTION_PATH, "utf8");

function allQueuesBlock(): string {
  // Each registrar owns its own `const allQueues = [...]`; union every block so
  // a queue registered in either the status or rollup registrar satisfies the
  // membership assertion.
  const blocks = [...source.matchAll(/const allQueues\s*=\s*\[([\s\S]*?)\];/g)];
  expect(blocks.length).toBeGreaterThan(0);
  return blocks.map((m) => m[1]).join("\n");
}

describe("reminder-worker — stress-score wiring", () => {
  it("imports the queue symbols from the stress-score module", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/jobs\/stress-score["']/);
    expect(source).toMatch(/\bSTRESS_SCORE_QUEUE\b/);
    expect(source).toMatch(/\bSTRESS_SCORE_CRON\b/);
    expect(source).toMatch(/\brunStressScore\b/);
  });

  it("registers the stress-score queue in allQueues", () => {
    expect(allQueuesBlock()).toMatch(/\bSTRESS_SCORE_QUEUE\b/);
  });

  it("schedules the stress-score cron", () => {
    expect(source).toMatch(/\[STRESS_SCORE_QUEUE,\s*STRESS_SCORE_CRON\]/);
  });

  it("registers a createAndWork handler that runs the stress-score pass", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,200}STRESS_SCORE_QUEUE[\s\S]{0,400}runStressScore/,
    );
  });
});

describe("reminder-worker — strain-score wiring", () => {
  it("imports the queue symbols from the strain-score module", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/jobs\/strain-score["']/);
    expect(source).toMatch(/\bSTRAIN_SCORE_QUEUE\b/);
    expect(source).toMatch(/\bSTRAIN_SCORE_CRON\b/);
    expect(source).toMatch(/\brunStrainScore\b/);
  });

  it("registers the strain-score queue in allQueues", () => {
    expect(allQueuesBlock()).toMatch(/\bSTRAIN_SCORE_QUEUE\b/);
  });

  it("schedules the strain-score cron", () => {
    expect(source).toMatch(/\[STRAIN_SCORE_QUEUE,\s*STRAIN_SCORE_CRON\]/);
  });

  it("registers a createAndWork handler that runs the strain-score pass", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,200}STRAIN_SCORE_QUEUE[\s\S]{0,400}runStrainScore/,
    );
  });
});

describe("reminder-worker — dense intra-day retention wiring", () => {
  it("imports the queue symbols from the dense-intraday-retention module", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/jobs\/dense-intraday-retention["']/,
    );
    expect(source).toMatch(/\bDENSE_INTRADAY_RETENTION_QUEUE\b/);
    expect(source).toMatch(/\brunDenseIntradayRetentionForUser\b/);
    expect(source).toMatch(/\benqueueBootTimeDenseIntradayRetention\b/);
  });

  it("registers the dense-intraday-retention queue in allQueues", () => {
    expect(allQueuesBlock()).toMatch(/\bDENSE_INTRADAY_RETENTION_QUEUE\b/);
  });

  it("registers a createAndWork handler against the dense-intraday-retention queue", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,250}DENSE_INTRADAY_RETENTION_QUEUE[\s\S]{0,500}runDenseIntradayRetentionForUser/,
    );
  });

  it("fires the boot-discovery enqueue helper", () => {
    expect(source).toMatch(/await enqueueBootTimeDenseIntradayRetention\(\)/);
  });

  it("defers the boot-discovery drain past the startup storm (P2028 guard)", () => {
    // The boot-time per-user retention jobs MUST carry a startAfter delay so
    // the transaction-per-day drain never contends with the deploy storm +
    // migration + other boot backfills + foreground health-checks for the
    // shared connection pool. Dropping this re-opens the v1.10.0 pool-
    // exhaustion (P2028) restart loop on a data-heavy tenant.
    expect(denseRetentionSource).toMatch(
      /DENSE_INTRADAY_RETENTION_BOOT_DELAY_SECONDS\s*=\s*\d+/,
    );
    expect(denseRetentionSource).toMatch(
      /boss\.send\([\s\S]{0,400}startAfter:\s*DENSE_INTRADAY_RETENTION_BOOT_DELAY_SECONDS/,
    );
  });

  it("folds the nightly dense-retention walk onto the drain-cumulative tick", () => {
    // The steady-state nightly walk runs the global (no-userId) pass on the
    // same tick as the cumulative + mean drains.
    expect(source).toMatch(/runDenseIntradayRetention\(\s*getWorkerPrisma\(\)/);
  });

  it("surfaces the iOS#34 derived-resting count in the per-user worker log", () => {
    // The PULSE facet mints derived RESTING_HEART_RATE rows for proxy users;
    // the per-user handler returns the count and the worker logs it so the
    // signal-preservation is observable in production.
    expect(source).toMatch(/derivedRestingRowsUpserted/);
  });
});

describe("reminder-worker — dense hourly-rebuild wiring", () => {
  it("imports the queue symbols from the dense-intraday-hourly-rebuild module", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/jobs\/dense-intraday-hourly-rebuild["']/,
    );
    expect(source).toMatch(/\bDENSE_INTRADAY_HOURLY_REBUILD_QUEUE\b/);
    expect(source).toMatch(/\brunDenseIntradayHourlyRebuildForUser\b/);
    expect(source).toMatch(/\benqueueBootTimeDenseIntradayHourlyRebuild\b/);
  });

  it("registers the hourly-rebuild queue in allQueues", () => {
    expect(allQueuesBlock()).toMatch(/\bDENSE_INTRADAY_HOURLY_REBUILD_QUEUE\b/);
  });

  it("registers a createAndWork handler against the hourly-rebuild queue", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,250}DENSE_INTRADAY_HOURLY_REBUILD_QUEUE[\s\S]{0,500}runDenseIntradayHourlyRebuildForUser/,
    );
  });

  it("fires the boot-discovery enqueue helper", () => {
    expect(source).toMatch(
      /await enqueueBootTimeDenseIntradayHourlyRebuild\(\)/,
    );
  });

  it("defers the boot-discovery rebuild past the startup storm (P2028 guard)", () => {
    const REBUILD_PATH = join(
      __dirname,
      "..",
      "dense-intraday-hourly-rebuild.ts",
    );
    const rebuildSource = readFileSync(REBUILD_PATH, "utf8");
    expect(rebuildSource).toMatch(
      /DENSE_INTRADAY_HOURLY_REBUILD_BOOT_DELAY_SECONDS\s*=\s*\d+/,
    );
    expect(rebuildSource).toMatch(
      /startAfter:\s*DENSE_INTRADAY_HOURLY_REBUILD_BOOT_DELAY_SECONDS/,
    );
  });
});
