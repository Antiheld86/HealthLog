/**
 * v1.10.0 — computed scores (WX-C). Recovery-score queue registration guard.
 *
 * Same source-text-grep approach as the other queue-wiring guards: assert
 * the queue is imported, registered in `allQueues`, scheduled, and wired to
 * a `createAndWork` handler — without booting pg-boss + Prisma. An unregistered
 * queue silently never drains (the recurring past bug this guards against).
 *
 * Also pins the iOS-write rejection of the server-owned COMPUTED source on
 * the batch ingest route: the `batchSourceEnum` allowlist must stay exactly
 * `{APPLE_HEALTH, MANUAL}`, so COMPUTED (like WITHINGS / IMPORT) can never be
 * forged by a client.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the queue wiring moved out of the 2143-LOC reminder-worker boot
// file into domain registrars; the recovery-score queue lives in the status
// registrar. The dead-queue guard follows the wiring there.
const REGISTRAR_PATH = join(__dirname, "..", "reminder", "register-status.ts");
const workerSource = readFileSync(REGISTRAR_PATH, "utf8");

const BATCH_ROUTE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "app",
  "api",
  "measurements",
  "batch",
  "route.ts",
);
const batchSource = readFileSync(BATCH_ROUTE_PATH, "utf8");

describe("reminder-worker — recovery-score wiring", () => {
  it("imports the queue symbols from the recovery-score module", () => {
    expect(workerSource).toMatch(/from\s*["']@\/lib\/jobs\/recovery-score["']/);
    expect(workerSource).toMatch(/\bRECOVERY_SCORE_QUEUE\b/);
    expect(workerSource).toMatch(/\bRECOVERY_SCORE_CRON\b/);
    expect(workerSource).toMatch(/\brunRecoveryScore\b/);
  });

  it("registers the recovery-score queue in the allQueues loop", () => {
    const allQueuesMatch = workerSource.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bRECOVERY_SCORE_QUEUE\b/);
  });

  it("schedules the recovery-score cron", () => {
    expect(workerSource).toMatch(
      /\[RECOVERY_SCORE_QUEUE,\s*RECOVERY_SCORE_CRON\]/,
    );
  });

  it("registers a createAndWork handler that runs the recovery-score pass", () => {
    expect(workerSource).toMatch(
      /createAndWork[\s\S]{0,200}RECOVERY_SCORE_QUEUE[\s\S]{0,400}runRecoveryScore/,
    );
  });
});

describe("measurements batch route — COMPUTED iOS-write rejection", () => {
  it("keeps the batch source allowlist to APPLE_HEALTH + MANUAL only", () => {
    // The server-owned sources (COMPUTED / WITHINGS / IMPORT) are excluded
    // by construction: the client-facing batch enum is exactly this pair.
    expect(batchSource).toMatch(
      /batchSourceEnum\s*=\s*z\.enum\(\[\s*"APPLE_HEALTH"\s*,\s*"MANUAL"\s*\]\)/,
    );
    expect(batchSource).not.toMatch(/batchSourceEnum[\s\S]{0,80}"COMPUTED"/);
  });
});
