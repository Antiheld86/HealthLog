/**
 * v1.4.37 dead-queue guard for the `data-arrival` queue.
 *
 * Four facts have to hold together or the spine is silently inert: the queue
 * name is provisioned, a handler drains it, the queue carries a policy that
 * actually indexes `singleton_key`, and the retention job that prunes its rows
 * is itself registered. Any one of them missing fails open in the worst way —
 * the emits succeed, the jobs vanish, and nothing anywhere reports a problem.
 *
 * Source-text assertions over the registrar modules, matching the shape of the
 * sibling `*-queue.test.ts` guards.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const statusRegistrar = readFileSync(
  join(__dirname, "..", "reminder", "register-status.ts"),
  "utf8",
);

const maintenanceSource =
  readFileSync(
    join(__dirname, "..", "reminder", "register-maintenance.ts"),
    "utf8",
  ) +
  readFileSync(
    join(__dirname, "..", "reminder", "cleanup-handlers.ts"),
    "utf8",
  );

describe("data-arrival queue wiring", () => {
  it("provisions the queue in the allQueues list", () => {
    const allQueues = statusRegistrar.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueues).not.toBeNull();
    expect(allQueues![1]).toMatch(/\bDATA_ARRIVAL_QUEUE\b/);
  });

  it("binds a createAndWork handler that drains it", () => {
    expect(statusRegistrar).toMatch(
      /createAndWork[\s\S]{0,200}DATA_ARRIVAL_QUEUE[\s\S]{0,200}handleDataArrival/,
    );
  });

  it("carries the exclusive policy its singleton keys depend on", () => {
    // Under pg-boss's default `standard` policy NO index covers
    // `singleton_key`, so the day-scoped keys would coalesce nothing at all and
    // a chatty ingest would queue one job per batch. This assertion is anchored
    // INSIDE the extracted policy table so an unrelated mention of the queue
    // name elsewhere in the file cannot satisfy it.
    const table = statusRegistrar.match(
      /const queuePolicies: QueuePolicyTable\s*=\s*\{([\s\S]*?)\n\};/,
    );
    expect(table).not.toBeNull();
    expect(table![1]).toMatch(
      /\[DATA_ARRIVAL_QUEUE\][\s\S]{0,200}policy:\s*"exclusive"/,
    );
  });

  it("has no cron schedule — it is send-only, driven by ingest", () => {
    // Tolerates the optional third schedule element, so a cron sneaking in
    // with send options still trips this.
    expect(statusRegistrar).not.toMatch(
      /\[\s*DATA_ARRIVAL_QUEUE,\s*\w+_CRON\s*[,\]]/,
    );
  });

  it("registers the retention job that prunes the markers", () => {
    const allQueues = maintenanceSource.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueues).not.toBeNull();
    expect(allQueues![1]).toMatch(/\bARRIVAL_REACTION_CLEANUP_QUEUE\b/);
    expect(maintenanceSource).toMatch(
      /\[\s*ARRIVAL_REACTION_CLEANUP_QUEUE,\s*ARRIVAL_REACTION_CLEANUP_CRON,\s*cronIsTheRetry,?\s*\]/,
    );
    expect(maintenanceSource).toMatch(
      /createAndWork[\s\S]{0,200}ARRIVAL_REACTION_CLEANUP_QUEUE[\s\S]{0,200}handleArrivalReactionCleanup/,
    );
  });

  it("the retention handler actually deletes arrival reactions by age", () => {
    expect(maintenanceSource).toMatch(
      /handleArrivalReactionCleanup[\s\S]{0,600}arrivalReaction\.deleteMany/,
    );
  });
});
