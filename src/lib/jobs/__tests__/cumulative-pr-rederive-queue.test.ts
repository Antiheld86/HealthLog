/**
 * v1.30.3 (QA F4) — cumulative-PersonalRecord rederivation queue
 * registration guard.
 *
 * Same source-text-grep approach as the step-consolidation-repair guard:
 * assert the queue is registered in `allQueues`, a `createAndWork` handler is
 * wired against it, and the boot-discovery enqueue helper fires — without
 * booting pg-boss + Prisma. An unregistered queue silently never drains
 * (the v1.4.37 dead-queue class).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REGISTRAR_PATH = join(__dirname, "..", "reminder", "register-rollup.ts");
const source = readFileSync(REGISTRAR_PATH, "utf8");

describe("reminder-worker — cumulative-pr-rederive wiring", () => {
  it("imports the queue symbols from the rederivation module", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/personal-records\/cumulative-pr-rederivation["']/,
    );
    expect(source).toMatch(/\bCUMULATIVE_PR_REDERIVE_QUEUE\b/);
    expect(source).toMatch(/\brunCumulativePrRederivationForUser\b/);
    expect(source).toMatch(/\benqueueBootTimeCumulativePrRederivation\b/);
  });

  it("registers the queue in the allQueues loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bCUMULATIVE_PR_REDERIVE_QUEUE\b/);
  });

  it("registers a createAndWork handler against the queue", () => {
    expect(source).toMatch(
      /createAndWork[\s\S]{0,200}CUMULATIVE_PR_REDERIVE_QUEUE[\s\S]{0,400}runCumulativePrRederivationForUser/,
    );
  });

  it("fires the boot-discovery enqueue helper", () => {
    expect(source).toMatch(
      /await enqueueBootTimeCumulativePrRederivation\([^)]*\)/,
    );
  });
});
