/**
 * v1.17.0 — pg-boss queue registration for the three new poll-only sync layers:
 * Nightscout CGM, Polar, and Oura.
 *
 * Source-as-text guard (the reminder-worker pulls heavy infra we don't boot
 * here): assert each queue constant + cron + handler wiring + allQueues
 * membership are present — the fast guard against the v1.4.37 dead-queue class
 * (a queue declared but never registered in `allQueues`, which silently never
 * drains). All three syncs are poll-only (no webhook, no backfill queue): a
 * single hourly tick walks every configured account.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the queue wiring moved out of the 2143-LOC reminder-worker boot
// file into domain registrars; the Nightscout / Polar / Oura queues live in the
// integration-sync registrar. The dead-queue guard follows the wiring there
// (the handler module is still concatenated for the handler-symbol assertions).
//
// v1.32.28 — the four poll-queue NAMES moved again, into
// `integration-poll-queues.ts`, so an OAuth callback can enqueue a connect-time
// first sync without importing the registrar's handler graph. The guard follows
// them: the name declarations are asserted against that module, everything else
// (allQueues membership, cron schedule, handler binding) still against the
// registrar.
const source =
  readFileSync(join(__dirname, "..", "integration-poll-queues.ts"), "utf8") +
  readFileSync(
    join(__dirname, "..", "reminder", "register-integration-sync.ts"),
    "utf8",
  ) +
  readFileSync(join(__dirname, "..", "reminder", "nightscout-sync.ts"), "utf8");

describe("reminder-worker — Nightscout sync queue", () => {
  it("declares the nightscout-sync queue constant", () => {
    expect(source).toMatch(
      /NIGHTSCOUT_SYNC_QUEUE\s*=\s*["']nightscout-sync["']/,
    );
  });

  it("registers the queue in allQueues (v1.4.37 dead-queue guard)", () => {
    const block = /const allQueues = \[([\s\S]*?)\];/.exec(source);
    expect(block).not.toBeNull();
    expect(block![1]!).toContain("NIGHTSCOUT_SYNC_QUEUE");
  });

  it("schedules the hourly poll cron", () => {
    expect(source).toMatch(/\[NIGHTSCOUT_SYNC_QUEUE,\s*NIGHTSCOUT_SYNC_CRON\]/);
  });

  it("registers a boss.work handler for the queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,160}NIGHTSCOUT_SYNC_QUEUE[\s\S]{0,160}handleNightscoutSync/,
    );
  });
});

describe("reminder-worker — Polar / Oura sync queues", () => {
  // The same v1.4.37 dead-queue class applies to the two OAuth-wearable polls
  // shipped alongside Nightscout in v1.17.0 — assert their allQueues membership
  // so a future refactor can't silently drop one and starve the sync.
  const allQueuesBlock = () => {
    const block = /const allQueues = \[([\s\S]*?)\];/.exec(source);
    expect(block).not.toBeNull();
    return block![1]!;
  };

  it("declares the polar-sync and oura-sync queue constants", () => {
    expect(source).toMatch(/POLAR_SYNC_QUEUE\s*=\s*["']polar-sync["']/);
    expect(source).toMatch(/OURA_SYNC_QUEUE\s*=\s*["']oura-sync["']/);
  });

  it("registers POLAR_SYNC_QUEUE in allQueues (v1.4.37 dead-queue guard)", () => {
    expect(allQueuesBlock()).toContain("POLAR_SYNC_QUEUE");
  });

  it("registers OURA_SYNC_QUEUE in allQueues (v1.4.37 dead-queue guard)", () => {
    expect(allQueuesBlock()).toContain("OURA_SYNC_QUEUE");
  });

  it("schedules the hourly poll cron for both", () => {
    expect(source).toMatch(/\[POLAR_SYNC_QUEUE,\s*POLAR_SYNC_CRON\]/);
    expect(source).toMatch(/\[OURA_SYNC_QUEUE,\s*OURA_SYNC_CRON\]/);
  });

  it("registers a boss.work handler for each queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,160}POLAR_SYNC_QUEUE[\s\S]{0,160}handlePolarSync/,
    );
    expect(source).toMatch(
      /boss\.work[\s\S]{0,160}OURA_SYNC_QUEUE[\s\S]{0,160}handleOuraSync/,
    );
  });
});
