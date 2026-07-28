/**
 * v1.8.2 — duplicate dose-slot dedup queue registration guard.
 *
 * Same source-text-grep approach as the drain + step-consolidation +
 * mean-consolidation regression guards: assert the queue is registered
 * in `allQueues`, a `createAndWork` handler is wired against it, and the
 * boot-discovery enqueue helper is called — without booting pg-boss +
 * Prisma. An unregistered queue silently never drains (the past incident
 * this guard exists to prevent).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the intake-slot-dedup wiring + boot discovery moved out of the
// 2143-LOC reminder-worker boot file into the maintenance registrar. The
// dead-queue guard follows the wiring there.
const REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-maintenance.ts",
);
const source = readFileSync(REGISTRAR_PATH, "utf8");

describe("reminder-worker — intake-slot-dedup wiring", () => {
  it("imports the queue symbols from the intake-slot-dedup module", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/medications\/intake-slot-dedup["']/,
    );
    expect(source).toMatch(/\bINTAKE_SLOT_DEDUP_QUEUE\b/);
    expect(source).toMatch(/\bdedupeUserIntakeSlots\b/);
    expect(source).toMatch(/\benqueueBootTimeIntakeSlotDedup\b/);
  });

  it("registers the intake-slot-dedup queue in the allQueues loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bINTAKE_SLOT_DEDUP_QUEUE\b/);
  });

  it("registers a createAndWork handler against the intake-slot-dedup queue", () => {
    // v1.15.19 — span widened from {0,400}: the handler gained the daily
    // cron-tick dispatch branch (no `userId` → discovery fan-out) between
    // the queue name and the per-user dedup call.
    expect(source).toMatch(
      /createAndWork[\s\S]{0,200}INTAKE_SLOT_DEDUP_QUEUE[\s\S]{0,1400}dedupeUserIntakeSlots/,
    );
  });

  it("fires the boot-discovery enqueue helper", () => {
    expect(source).toMatch(/await enqueueBootTimeIntakeSlotDedup\(\)/);
  });

  // v1.15.19 — the boot-only pass left duplicates created between deploys
  // standing until the next worker restart. The queue now also carries a
  // daily cron tick whose empty payload (no `userId`) dispatches the same
  // discovery fan-out.
  it("declares a daily cron inside the 03:xx maintenance window", () => {
    const cronMatch = source.match(
      /const INTAKE_SLOT_DEDUP_CRON\s*=\s*["']([^"']+)["']/,
    );
    expect(cronMatch).not.toBeNull();
    // Five-field cron, daily (day-of-month/month/day-of-week all `*`),
    // inside the 03:xx maintenance window.
    expect(cronMatch![1]).toMatch(/^\d{1,2} 3 \* \* \*$/);
  });

  it("registers the cron in the schedules table", () => {
    // v1.15.20 — the schedules tuple grew an optional send-options slot
    // (retry policy for the insight queues); match on the assignment, not
    // the exact tuple type.
    // v1.18.1 — `schedules` is now a module-level const in the registrar, so it
    // closes at column 0 (`\n];`) rather than the monolith's function-body
    // two-space indent.
    const schedulesMatch = source.match(
      /const schedules:[^=]*=\s*\[([\s\S]*?)\n\];/,
    );
    expect(schedulesMatch).not.toBeNull();
    expect(schedulesMatch![1]).toMatch(
      /\[INTAKE_SLOT_DEDUP_QUEUE,\s*INTAKE_SLOT_DEDUP_CRON\]/,
    );
  });

  it("dispatches a payload without userId to the discovery fan-out", () => {
    // The handler must branch on the missing `userId` BEFORE the per-user
    // dedup call, and the branch must run the discovery helper.
    expect(source).toMatch(
      /INTAKE_SLOT_DEDUP_QUEUE[\s\S]{0,800}if \(!userId\) \{[\s\S]{0,400}enqueueBootTimeIntakeSlotDedup\(\)/,
    );
  });
});
