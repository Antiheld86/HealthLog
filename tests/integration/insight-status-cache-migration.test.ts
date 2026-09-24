/**
 * Migration 0344: status notes move out of the audit log.
 *
 * The container this suite runs on has every migration applied already, so
 * the new table is asserted as it landed (columns, the one-row-per-note
 * unique key, the cascade from the user), and the destructive data step is
 * pulled out of the `.sql` file and run again against rows seeded the way an
 * upgrading instance holds them: the old status rows go, and every other
 * audit row stays, including the ones whose action merely starts with
 * `insights.`.
 *
 * The step runs twice; the second run must change nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const MIGRATION = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "0344_insight_status_cache",
    "migration.sql",
  ),
  "utf8",
);

/** Every `DELETE … ;` statement in the migration, comments stripped. */
function dataSteps(): string[] {
  const sql = MIGRATION.split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const steps = [...sql.matchAll(/DELETE\s+FROM\s+"[a-z_]+"[\s\S]*?;/gi)].map(
    (m) => m[0],
  );
  // The data step is the point; an empty match is a failure, not a pass.
  expect(steps.length).toBe(1);
  return steps;
}

async function runDataSteps() {
  const prisma = getPrismaClient();
  for (const step of dataSteps()) await prisma.$executeRawUnsafe(step);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("the new table", () => {
  it("keys one note per (user, metric, locale) and cascades from the user", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: { username: "mig-0344", email: "mig-0344@example.test" },
    });
    await prisma.insightStatusCache.create({
      data: {
        userId: user.id,
        metric: "weight",
        locale: "en",
        dateKey: "2026-09-20",
        textEncrypted: Buffer.from("ciphertext-stand-in", "utf8"),
      },
    });
    await expect(
      prisma.insightStatusCache.create({
        data: {
          userId: user.id,
          metric: "weight",
          locale: "en",
          dateKey: "2026-09-21",
        },
      }),
    ).rejects.toThrow();

    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.insightStatusCache.count()).toBe(0);
  });
});

describe("the audit-log purge", () => {
  it("deletes every status note row and nothing else", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: { username: "mig-0344-audit", email: "mig-0344-a@example.test" },
    });
    const statusActions = [
      "insights.weight-status.en",
      "insights.blood-pressure-status.de",
      "insights.metric:RESTING_HEART_RATE-status.fr",
      "insights.derived-score:READINESS-status.en",
      "insights.biomarker:ldl-status.it",
      "insights.medication-compliance-status.pl",
    ];
    const kept = [
      "insights.generate",
      "insights.coach.fence_drift",
      "insights.recommendation.feedback",
      "auth.login",
      "consent.ai.revoke",
    ];
    for (const action of [...statusActions, ...kept]) {
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action,
          details: JSON.stringify({ text: "plaintext" }),
        },
      });
    }

    await runDataSteps();
    await runDataSteps();

    const remaining = await prisma.auditLog.findMany({
      select: { action: true },
      orderBy: { action: "asc" },
    });
    expect(remaining.map((r) => r.action)).toEqual([...kept].sort());
  });
});
