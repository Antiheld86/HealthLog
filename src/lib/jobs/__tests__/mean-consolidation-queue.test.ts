/**
 * v1.7.0 — daily-mean consolidation queue registration guard.
 *
 * Same source-text-grep approach as the drain + step-consolidation
 * regression guards: assert the queue is registered in `allQueues`, a
 * `createAndWork` handler is wired against it, and the boot-discovery
 * enqueue helper is called — without booting pg-boss + Prisma. An
 * unregistered queue silently never drains.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the mean-consolidation wiring + boot discovery moved out of the
// 2143-LOC reminder-worker boot file into the rollup registrar. The dead-queue
// guard follows the wiring there.
const REGISTRAR_PATH = join(__dirname, "..", "reminder", "register-rollup.ts");
const source = readFileSync(REGISTRAR_PATH, "utf8");

describe("reminder-worker — mean-consolidation wiring", () => {
  it("imports the queue symbols from the mean-consolidation module", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/jobs\/mean-consolidation["']/);
    expect(source).toMatch(/\bMEAN_CONSOLIDATION_QUEUE\b/);
    expect(source).toMatch(/\brunMeanConsolidationForUser\b/);
    expect(source).toMatch(/\benqueueBootTimeMeanConsolidation\b/);
  });

  it("registers the mean-consolidation queue in the allQueues loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bMEAN_CONSOLIDATION_QUEUE\b/);
  });

  it("registers a createAndWork handler against the mean-consolidation queue", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,200}MEAN_CONSOLIDATION_QUEUE[\s\S]{0,400}runMeanConsolidationForUser/,
    );
  });

  it("fires the boot-discovery enqueue helper", () => {
    // The boot wiring passes a stagger offset so the heavy backfills don't all
    // drain in parallel onto one tenant; allow an optional argument here.
    expect(source).toMatch(/await enqueueBootTimeMeanConsolidation\([^)]*\)/);
  });
});
