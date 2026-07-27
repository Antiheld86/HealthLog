/**
 * v1.18.7 — coach-message-cleanup queue registration guard.
 *
 * Same source-text-grep approach as the other queue-wiring guards: assert the
 * queue is registered in `allQueues`, scheduled, and wired to a `createAndWork`
 * handler — without booting pg-boss + Prisma. An unregistered queue silently
 * never drains (the recurring v1.4.37 dead-queue bug), which would leave the
 * encrypted Coach history growing unbounded with the retention job dark.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-maintenance.ts",
);
const workerSource =
  readFileSync(REGISTRAR_PATH, "utf8") +
  readFileSync(
    join(__dirname, "..", "reminder", "cleanup-handlers.ts"),
    "utf8",
  );

describe("reminder-worker — coach-message-cleanup wiring", () => {
  it("imports the cleanup handler from the cleanup-handlers module", () => {
    expect(workerSource).toMatch(/\bhandleCoachMessageCleanup\b/);
    expect(workerSource).toMatch(/\bCoachMessageCleanupPayload\b/);
  });

  it("registers the coach-message-cleanup queue in the allQueues loop", () => {
    const allQueuesMatch = workerSource.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bCOACH_MESSAGE_CLEANUP_QUEUE\b/);
  });

  it("schedules the coach-message-cleanup cron", () => {
    expect(workerSource).toMatch(
      /\[COACH_MESSAGE_CLEANUP_QUEUE,\s*COACH_MESSAGE_CLEANUP_CRON,\s*cronIsTheRetry\]/,
    );
  });

  it("registers a createAndWork handler for the queue", () => {
    expect(workerSource).toMatch(
      /createAndWork[\s\S]{0,200}COACH_MESSAGE_CLEANUP_QUEUE[\s\S]{0,200}handleCoachMessageCleanup/,
    );
  });

  it("prunes coach messages inside the handler", () => {
    expect(workerSource).toMatch(
      /handleCoachMessageCleanup[\s\S]{0,400}cleanupOldCoachMessages/,
    );
  });
});
