/**
 * v1.12.2 ios-coord — TLS-pin-monitor queue registration guard.
 *
 * Same source-text-grep approach as the other queue-wiring guards: assert
 * the queue is imported, registered in `allQueues`, scheduled, and wired to
 * a `createAndWork` handler — without booting pg-boss + Prisma. An unregistered
 * queue silently never drains (the recurring v1.4.37 dead-queue bug), which
 * would leave the pinned-leaf-rotation alarm dark.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the TLS-pin-monitor wiring moved out of the 2143-LOC
// reminder-worker boot file into the maintenance registrar. The dead-queue
// guard follows the wiring there (the ops-handlers module is still concatenated
// for the handler-body `runTlsPinMonitor` assertion).
const REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-maintenance.ts",
);
const workerSource =
  readFileSync(REGISTRAR_PATH, "utf8") +
  readFileSync(join(__dirname, "..", "reminder", "ops-handlers.ts"), "utf8");

describe("reminder-worker — tls-pin-monitor wiring", () => {
  it("imports the queue symbols from the tls-pin-monitor module", () => {
    expect(workerSource).toMatch(
      /from\s*["']@\/lib\/jobs\/tls-pin-monitor["']/,
    );
    expect(workerSource).toMatch(/\bTLS_PIN_MONITOR_QUEUE\b/);
    expect(workerSource).toMatch(/\bTLS_PIN_MONITOR_CRON\b/);
    expect(workerSource).toMatch(/\brunTlsPinMonitor\b/);
  });

  it("registers the tls-pin-monitor queue in the allQueues loop", () => {
    const allQueuesMatch = workerSource.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bTLS_PIN_MONITOR_QUEUE\b/);
  });

  it("schedules the tls-pin-monitor cron", () => {
    expect(workerSource).toMatch(
      /\[TLS_PIN_MONITOR_QUEUE,\s*TLS_PIN_MONITOR_CRON\]/,
    );
  });

  it("registers a createAndWork handler for the queue", () => {
    expect(workerSource).toMatch(
      /createAndWork[\s\S]{0,200}TLS_PIN_MONITOR_QUEUE[\s\S]{0,200}handleTlsPinMonitor/,
    );
  });

  it("runs the monitor pass inside the handler", () => {
    expect(workerSource).toMatch(
      /handleTlsPinMonitor[\s\S]{0,400}runTlsPinMonitor/,
    );
  });
});
