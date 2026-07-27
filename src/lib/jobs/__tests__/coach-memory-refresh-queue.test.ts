/**
 * v1.11.1 — queue-registration guard for the combined Coach memory-refresh
 * job (rolling conversation summary + durable fact extraction).
 *
 * Same source-text-grep approach as the period-narrative / stress-strain
 * guards: assert the queue is imported, registered in `allQueues`, and wired
 * to a `createAndWork` handler that runs the refresh pipeline — without booting
 * pg-boss + Prisma. An unregistered queue silently never runs (the recurring
 * past bug this guards against; v1.4.37 W10 caught exactly this class).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the coach-memory-refresh wiring moved out of the 2143-LOC
// reminder-worker boot file into the status registrar. The dead-queue guard
// follows the wiring there.
const REGISTRAR_PATH = join(__dirname, "..", "reminder", "register-status.ts");
const source = readFileSync(REGISTRAR_PATH, "utf8");

function allQueuesBlock(): string {
  const m = source.match(/const allQueues\s*=\s*\[([\s\S]*?)\];/);
  expect(m).not.toBeNull();
  return m![1];
}

describe("reminder-worker — coach-memory-refresh wiring", () => {
  it("imports the queue symbol + worker from the coach-memory modules", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/ai\/coach\/coach-memory-shared["']/,
    );
    expect(source).toMatch(/\bCOACH_MEMORY_REFRESH_QUEUE\b/);
    expect(source).toMatch(
      /from\s*["']@\/lib\/ai\/coach\/coach-memory-refresh-worker["']/,
    );
    expect(source).toMatch(/\brunCoachMemoryRefresh\b/);
  });

  it("registers the coach-memory-refresh queue in allQueues", () => {
    expect(allQueuesBlock()).toMatch(/\bCOACH_MEMORY_REFRESH_QUEUE\b/);
  });

  it("registers a createAndWork handler that runs the refresh pipeline", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,200}COACH_MEMORY_REFRESH_QUEUE[\s\S]{0,600}runCoachMemoryRefresh/,
    );
  });
});
