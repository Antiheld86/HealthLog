/**
 * #646 — a broken background job says its own name.
 *
 * The environment fetch threw on every run for the whole life of the module.
 * It was logged and counted, and neither reached a screen: `recordError()`
 * increments one unnamed integer, and the worker log only exists where someone
 * is tailing the container. The queue held the answer the entire time.
 *
 * These readers query `pgboss.job` directly, so the only test worth having is
 * one against a schema pg-boss itself created. A hand-written `CREATE TABLE`
 * would prove the query matches the table the test wrote, which is exactly the
 * mistake being fixed. So pg-boss provisions its own schema here and the jobs
 * are failed through its own API.
 */
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readFailingQueues,
  readQueueFailureForUser,
} from "@/lib/jobs/job-failures";

import { getPrismaClient } from "./setup";

const QUEUE = "environment-fetch";
const OTHER_QUEUE = "reminder-check";

let boss: PgBoss;

/** Send a job, take it, and fail it terminally so it lands in `state='failed'`. */
async function failOneJob(queue: string, data: object, error: string) {
  const jobId = await boss.send(queue, data, { retryLimit: 0 });
  if (!jobId) throw new Error("queue rejected the job");
  const [job] = await boss.fetch(queue);
  if (!job) throw new Error("nothing to fetch");
  await boss.fail(queue, job.id, new Error(error));
  return jobId;
}

beforeAll(async () => {
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    // No maintenance or monitoring timers — the test drives every transition.
    supervise: false,
    schedule: false,
  });
  await boss.start();
  await boss.createQueue(QUEUE);
  await boss.createQueue(OTHER_QUEUE);
}, 60_000);

afterAll(async () => {
  await boss?.stop({ graceful: false, close: true });
  await getPrismaClient().$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS pgboss CASCADE`,
  );
});

describe("readFailingQueues", () => {
  it("names the queue, counts the failures, and carries the last error", async () => {
    await failOneJob(
      QUEUE,
      { userId: "user-a" },
      'type "public.EnvironmentLocationSource" does not exist',
    );
    await failOneJob(QUEUE, { userId: "user-b" }, "upstream feed unavailable");
    await failOneJob(OTHER_QUEUE, {}, "reminder dispatch failed");

    const failing = await readFailingQueues();
    expect(failing).not.toBeNull();

    const environment = failing?.find((entry) => entry.queue === QUEUE);
    expect(environment?.failures).toBe(2);
    expect(environment?.lastError).toBe("upstream feed unavailable");
    expect(Number.isFinite(Date.parse(environment?.lastFailedAt ?? ""))).toBe(
      true,
    );

    const other = failing?.find((entry) => entry.queue === OTHER_QUEUE);
    expect(other?.failures).toBe(1);
    expect(other?.lastError).toBe("reminder dispatch failed");
  });

  it("reports an empty list — not null — when nothing is failing", async () => {
    await getPrismaClient().$executeRawUnsafe(
      `DELETE FROM pgboss.job WHERE state = 'failed'`,
    );
    await expect(readFailingQueues()).resolves.toEqual([]);
  });

  it("ignores a failure older than the window", async () => {
    await failOneJob(QUEUE, { userId: "user-a" }, "old failure");
    await getPrismaClient().$executeRawUnsafe(
      `UPDATE pgboss.job SET completed_on = now() - interval '10 days' WHERE state = 'failed'`,
    );
    await expect(readFailingQueues(72)).resolves.toEqual([]);
  });
});

describe("readQueueFailureForUser", () => {
  it("matches on the userId the job payload carries", async () => {
    await getPrismaClient().$executeRawUnsafe(
      `DELETE FROM pgboss.job WHERE state = 'failed'`,
    );
    await failOneJob(QUEUE, { userId: "user-a" }, "first");
    await failOneJob(QUEUE, { userId: "user-a" }, "second");
    await failOneJob(QUEUE, { userId: "user-b" }, "someone else");

    const mine = await readQueueFailureForUser(QUEUE, "user-a");
    expect(mine?.failures).toBe(2);
    expect(Number.isFinite(Date.parse(mine?.lastFailedAt ?? ""))).toBe(true);

    // No error text on this side — the message is written for an operator.
    expect(Object.keys(mine ?? {}).sort()).toEqual([
      "failures",
      "lastFailedAt",
    ]);
  });

  it("answers null for an account whose jobs did not fail", async () => {
    await expect(
      readQueueFailureForUser(QUEUE, "user-with-no-failures"),
    ).resolves.toBeNull();
  });

  it("does not attribute another queue's failure to this one", async () => {
    await getPrismaClient().$executeRawUnsafe(
      `DELETE FROM pgboss.job WHERE state = 'failed'`,
    );
    await failOneJob(OTHER_QUEUE, { userId: "user-a" }, "reminder failed");
    await expect(readQueueFailureForUser(QUEUE, "user-a")).resolves.toBeNull();
  });
});

describe("no queue schema at all", () => {
  it("answers null rather than throwing, so the status page still renders", async () => {
    const prisma = getPrismaClient();
    await boss.stop({ graceful: false, close: true });
    await prisma.$executeRawUnsafe(`ALTER SCHEMA pgboss RENAME TO pgboss_gone`);
    try {
      await expect(readFailingQueues()).resolves.toBeNull();
      await expect(
        readQueueFailureForUser(QUEUE, "user-a"),
      ).resolves.toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER SCHEMA pgboss_gone RENAME TO pgboss`,
      );
    }
  });
});
