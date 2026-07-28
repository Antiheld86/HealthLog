/**
 * v1.17.1 — measurement-reminder queue registration guard.
 *
 * Same source-text-grep approach as the cycle / mood / drain registration
 * guards: assert the Vorsorge-reminder queue is declared, listed in
 * `allQueues` (the v1.4.37 dead-queue lesson — an unregistered queue is
 * never provisioned and the schedule silently no-ops), scheduled on its
 * cron, and wired to a `createAndWork` handler that delegates to
 * `runMeasurementReminderTick`. No pg-boss / Prisma boot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the reminder-dispatch wiring (measurement reminder +
// reminder-satisfy) moved out of the 2143-LOC reminder-worker boot file into
// the reminders registrar. The dead-queue guard follows the wiring there (the
// handler module is still concatenated for the handler-symbol assertions).
const source =
  readFileSync(
    join(__dirname, "..", "reminder", "register-reminders.ts"),
    "utf8",
  ) +
  readFileSync(
    join(__dirname, "..", "reminder", "mood-cycle-checks.ts"),
    "utf8",
  );

describe("reminder-worker — measurement-reminder wiring", () => {
  it("imports the measurement-reminder tick runner", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/jobs\/measurement-reminder["']/);
    expect(source).toMatch(/\brunMeasurementReminderTick\b/);
  });

  it("declares the queue + cron constants", () => {
    expect(source).toMatch(
      /MEASUREMENT_REMINDER_QUEUE\s*=\s*["']measurement-reminder-check["']/,
    );
    expect(source).toMatch(
      /MEASUREMENT_REMINDER_CRON\s*=\s*["']\*\/15 \* \* \* \*["']/,
    );
  });

  it("registers the queue in the allQueues loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bMEASUREMENT_REMINDER_QUEUE\b/);
  });

  it("schedules the measurement-reminder cron", () => {
    expect(source).toMatch(
      /\[MEASUREMENT_REMINDER_QUEUE,\s*MEASUREMENT_REMINDER_CRON\]/,
    );
  });

  it("registers a createAndWork handler that runs the tick", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,200}MEASUREMENT_REMINDER_QUEUE[\s\S]{0,200}handleMeasurementReminderCheck/,
    );
    expect(source).toMatch(
      /handleMeasurementReminderCheck[\s\S]{0,400}runMeasurementReminderTick/,
    );
  });
});

describe("reminder-worker — eventful reminder-satisfy wiring (v1.18.1)", () => {
  it("imports the satisfy queue constants", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/jobs\/reminder-satisfy["']/);
    expect(source).toMatch(/\bREMINDER_SATISFY_QUEUE\b/);
  });

  it("registers the satisfy queue in the allQueues loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bREMINDER_SATISFY_QUEUE\b/);
  });

  it("binds a createAndWork handler for the satisfy queue", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,200}REMINDER_SATISFY_QUEUE[\s\S]{0,200}handleReminderSatisfy/,
    );
    expect(source).toMatch(
      /handleReminderSatisfy[\s\S]{0,800}runReminderSatisfyForUser/,
    );
  });
});
