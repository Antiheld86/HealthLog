/**
 * Dead-queue guard for the two queues that took the writes off the read paths.
 *
 * Moving a write off a GET only works if the new owner actually runs. A queue
 * that is not in `allQueues` is never provisioned, a schedule without a
 * `createAndWork` binding drains into nothing, and either failure is silent:
 * the cron fires, the job vanishes, and the only symptom is a forecast that
 * stops moving or an unlock date that is never pinned. Both look exactly like
 * "nothing to do".
 *
 * Source-text assertions over the registrar, matching the sibling
 * `*-queue.test.ts` guards.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SUBSYSTEM_SURFACE } from "@/lib/jobs/subsystem-surface";

const registrar = readFileSync(
  join(__dirname, "..", "reminder", "register-maintenance.ts"),
  "utf8",
);

const allQueues = registrar.match(/const allQueues\s*=\s*\[([\s\S]*?)\n\];/);

const QUEUES = [
  {
    label: "cycle-prediction-refresh",
    binding: "CYCLE_PREDICTION_REFRESH_QUEUE",
    cron: "CYCLE_PREDICTION_REFRESH_CRON",
    handler: "handleCyclePredictionRefresh",
    name: "cycle-prediction-refresh",
  },
  {
    label: "achievement-unlock-sweep",
    binding: "ACHIEVEMENT_UNLOCK_SWEEP_QUEUE",
    cron: "ACHIEVEMENT_UNLOCK_SWEEP_CRON",
    handler: "handleAchievementUnlockSweep",
    name: "achievement-unlock-sweep",
  },
];

describe("queues that own a write moved off a GET", () => {
  it("extracted an allQueues list to assert against", () => {
    // The regexes below all read from this capture; if it ever stops
    // matching, every assertion in this file would pass on an empty string.
    expect(allQueues).not.toBeNull();
    expect(allQueues![1].length).toBeGreaterThan(0);
  });

  for (const queue of QUEUES) {
    describe(queue.label, () => {
      it("is provisioned in the allQueues list", () => {
        expect(allQueues![1]).toMatch(new RegExp(`\\b${queue.binding}\\b`));
      });

      it("carries a cron schedule", () => {
        expect(registrar).toMatch(
          new RegExp(`\\[\\s*${queue.binding},\\s*${queue.cron}`),
        );
      });

      it("binds a createAndWork handler that drains it", () => {
        expect(registrar).toMatch(
          new RegExp(
            `createAndWork[\\s\\S]{0,200}${queue.binding}[\\s\\S]{0,200}${queue.handler}`,
          ),
        );
      });

      it("declares a failure audience", () => {
        expect(Object.keys(SUBSYSTEM_SURFACE)).toContain(queue.name);
      });
    });
  }
});
