/**
 * v1.28.37 — step-consolidation repair queue registration guard +
 * `extractStatsDay` unit coverage.
 *
 * Same source-text-grep approach as the drain + step-consolidation +
 * mean-consolidation guards: assert the repair queue is registered in
 * `allQueues`, a `createAndWork` handler is wired against it, and the
 * boot-discovery enqueue helper fires — without booting pg-boss + Prisma.
 * An unregistered queue silently never drains (the dead-queue class).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractStatsDay } from "../step-consolidation-repair";

const REGISTRAR_PATH = join(__dirname, "..", "reminder", "register-rollup.ts");
const source = readFileSync(REGISTRAR_PATH, "utf8");

describe("reminder-worker — step-consolidation-repair wiring", () => {
  it("imports the queue symbols from the repair module", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/jobs\/step-consolidation-repair["']/,
    );
    expect(source).toMatch(/\bSTEP_CONSOLIDATION_REPAIR_QUEUE\b/);
    expect(source).toMatch(/\brunStepConsolidationRepairForUser\b/);
    expect(source).toMatch(/\benqueueBootTimeStepConsolidationRepair\b/);
  });

  it("registers the repair queue in the allQueues loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bSTEP_CONSOLIDATION_REPAIR_QUEUE\b/);
  });

  it("registers a createAndWork handler against the repair queue", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,200}STEP_CONSOLIDATION_REPAIR_QUEUE[\s\S]{0,400}runStepConsolidationRepairForUser/,
    );
  });

  it("fires the boot-discovery enqueue helper", () => {
    expect(source).toMatch(
      /await enqueueBootTimeStepConsolidationRepair\([^)]*\)/,
    );
  });
});

describe("extractStatsDay", () => {
  it("extracts the day key from a provider stats:steps externalId", () => {
    expect(extractStatsDay("stats:steps:2026-05-16")).toBe("2026-05-16");
  });

  it("extracts the day key from the narrow Apple mint shape", () => {
    expect(
      extractStatsDay("stats:HKQuantityTypeIdentifierStepCount:2026-05-16"),
    ).toBe("2026-05-16");
  });

  it("returns null for a null externalId or a non-day-suffixed key", () => {
    expect(extractStatsDay(null)).toBeNull();
    expect(extractStatsDay("uuid-abc-123")).toBeNull();
    expect(extractStatsDay("stats:steps:not-a-date")).toBeNull();
  });
});
