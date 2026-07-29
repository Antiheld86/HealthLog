/**
 * Durable success-output contract against pg-boss's own schema and worker.
 *
 * A unit test can prove `runJob` returns a value, but only pg-boss can prove
 * that the value reaches the completed job row's `output` JSONB column. This
 * test deliberately registers the production wrapper as the real worker
 * callback and reads the completed row back through pg-boss.
 */
import { PgBoss, type Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { jobDone } from "@/lib/jobs/job-outcome";
import { runJob } from "@/lib/jobs/run-job";

const QUEUE = `job-success-outcome-${Date.now()}-${Math.floor(
  Math.random() * 1e6,
)}`;

let boss: PgBoss;

async function waitForCompletedOutput(
  jobId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const job = await boss.getJobById(QUEUE, jobId);
    if (job?.state === "completed") {
      return (job.output ?? {}) as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("pg-boss job did not complete before the test deadline");
}

beforeAll(async () => {
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  await boss.createQueue(QUEUE);
}, 120_000);

afterAll(async () => {
  await boss?.stop({ graceful: false, close: true });
});

describe("runJob durable pg-boss success output", () => {
  it("persists only the bounded serialized outcome on completion", async () => {
    await boss.work<object, Record<string, unknown>>(
      QUEUE,
      { pollingIntervalSeconds: 0.5 },
      runJob(QUEUE, async (_jobs: Job<object>[]) =>
        jobDone({
          provider: "google_health",
          outcome: "useful",
          users_complete: 1,
          measurements_imported: 4,
        }),
      ),
    );

    const jobId = await boss.send(QUEUE, {});
    if (!jobId) throw new Error("queue rejected the integration-test job");

    await expect(waitForCompletedOutput(jobId)).resolves.toEqual({
      ok: true,
      did: {
        provider: "google_health",
        outcome: "useful",
        users_complete: 1,
        measurements_imported: 4,
      },
    });
  });
});
