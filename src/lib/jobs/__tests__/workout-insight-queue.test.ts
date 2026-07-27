/**
 * v1.4.37 dead-queue guard for the `workout-insight-generate` queue.
 *
 * This queue fails open in the worst possible way. Nothing warms it, no cron
 * touches it, and no read path triggers it — the ONLY thing that ever puts work
 * on it is the arrival spine's dispatch. So if the queue name is missing from
 * `allQueues`, pg-boss never provisions it, every `boss.send` resolves
 * successfully, every job vanishes, and the only symptom is that no workout
 * ever gets a paragraph. That is indistinguishable from the feature's own
 * honest empty state, which is exactly why it needs a structural guard rather
 * than a behavioural one.
 *
 * Source-text assertions over the registrar, matching the shape of the sibling
 * `*-queue.test.ts` guards.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const statusRegistrar = readFileSync(
  join(__dirname, "..", "reminder", "register-status.ts"),
  "utf8",
);

describe("workout-insight-generate queue wiring", () => {
  it("provisions the queue in the allQueues list", () => {
    const allQueues = statusRegistrar.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueues).not.toBeNull();
    expect(allQueues![1]).toMatch(/\bWORKOUT_INSIGHT_GENERATE_QUEUE\b/);
  });

  it("binds a createAndWork handler that drains it", () => {
    expect(statusRegistrar).toMatch(
      /createAndWork[\s\S]{0,300}WORKOUT_INSIGHT_GENERATE_QUEUE[\s\S]{0,300}handleWorkoutInsightGenerate/,
    );
  });

  it("runs the provider path serially", () => {
    // This IS the provider path the spine deliberately does not walk. Widening
    // the concurrency would let one sync's worth of workouts fan out into
    // parallel completions.
    expect(statusRegistrar).toMatch(
      /WORKOUT_INSIGHT_GENERATE_QUEUE[\s\S]{0,300}localConcurrency:\s*WORKOUT_INSIGHT_GENERATE_CONCURRENCY/,
    );
  });

  it("has no cron schedule — it is dispatched by arrival only", () => {
    // A cron here would be a standing invitation to regenerate, which is the
    // saturation surface the design refuses.
    // Tolerates the optional third schedule element, so a cron sneaking in
    // with send options still trips this.
    expect(statusRegistrar).not.toMatch(
      /\[\s*WORKOUT_INSIGHT_GENERATE_QUEUE,\s*\w+_CRON\s*[,\]]/,
    );
  });

  it("is reached from the spine only through the generator-free module", () => {
    // The spine's zero-spend claim is a module-graph property. If the worker
    // dispatch imported the generator, the provider clients would become
    // reachable from `data-arrival.ts` and the isolation guard would go red.
    const worker = readFileSync(
      join(__dirname, "..", "data-arrival.ts"),
      "utf8",
    );
    expect(worker).toMatch(
      /from "@\/lib\/jobs\/workout-insight-generate-shared"/,
    );
    expect(worker).not.toMatch(/from "@\/lib\/jobs\/workout-insight-generate"/);
  });
});
