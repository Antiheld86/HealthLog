/**
 * v1.15 — cycle-reminder queue registration guard.
 *
 * Same source-text-grep approach as the mood-reminder / drain / mean-
 * consolidation registration guards: assert the cycle-reminder queue is
 * declared, listed in `allQueues` (the v1.4.37 dead-queue lesson — an
 * unregistered queue is never provisioned and the schedule silently
 * no-ops), scheduled on its cron, and wired to a `createAndWork` handler that
 * delegates to `runCycleReminderTick`. No pg-boss / Prisma boot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the reminder-dispatch wiring moved out of the 2143-LOC
// reminder-worker boot file into the reminders registrar. The dead-queue guard
// follows the wiring there (the handler module is still concatenated for the
// handler-symbol assertions).
const REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-reminders.ts",
);
const source =
  readFileSync(REGISTRAR_PATH, "utf8") +
  readFileSync(
    join(__dirname, "..", "reminder", "mood-cycle-checks.ts"),
    "utf8",
  );

describe("reminder-worker — cycle-reminder wiring", () => {
  it("imports the cycle-reminder tick runner", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/jobs\/cycle-reminder["']/);
    expect(source).toMatch(/\brunCycleReminderTick\b/);
  });

  it("declares the queue + cron constants", () => {
    expect(source).toMatch(
      /CYCLE_REMINDER_QUEUE\s*=\s*["']cycle-reminder-check["']/,
    );
    expect(source).toMatch(
      /CYCLE_REMINDER_CRON\s*=\s*["']\*\/15 \* \* \* \*["']/,
    );
  });

  it("registers the cycle-reminder queue in the allQueues loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bCYCLE_REMINDER_QUEUE\b/);
  });

  it("schedules the cycle-reminder cron", () => {
    expect(source).toMatch(/\[CYCLE_REMINDER_QUEUE,\s*CYCLE_REMINDER_CRON\]/);
  });

  it("registers a createAndWork handler that runs the cycle-reminder tick", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,200}CYCLE_REMINDER_QUEUE[\s\S]{0,200}handleCycleReminderCheck/,
    );
    expect(source).toMatch(
      /handleCycleReminderCheck[\s\S]{0,400}runCycleReminderTick/,
    );
  });
});
