/**
 * Migration 0343: the data steps, read out of the migration and executed.
 *
 * The container this suite runs on has every migration applied already, so
 * the column changes are asserted as they landed, and the two data steps are
 * pulled out of the `.sql` file and run again against rows seeded the way an
 * upgrading instance holds them:
 *
 *   - one operator Coach switch: a stored Coach availability of `false`
 *     becomes `assistant_coach_enabled = false`, and the `coach` key leaves
 *     the availability blob whatever it said;
 *   - "hide Coach" keeps its privacy promise: everyone with
 *     `disable_coach = true` gets the AI analysis opt-out (`insights: false`)
 *     merged into their module preferences, whatever shape those were in.
 *
 * Both run twice, and the second run must change no value: a migration
 * re-applied to a database that has since moved on must not undo anything.
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
    "0343_ai_capability_switches",
    "migration.sql",
  ),
  "utf8",
);

/** Every `UPDATE … ;` statement in the migration, comments stripped. */
function dataSteps(): string[] {
  const sql = MIGRATION.split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const steps = [...sql.matchAll(/UPDATE\s+"[a-z_]+"[\s\S]*?;/gi)].map(
    (m) => m[0],
  );
  // The data steps are the point; an empty match is a failure, not a pass.
  expect(steps.length).toBe(3);
  return steps;
}

async function runDataSteps() {
  const prisma = getPrismaClient();
  for (const step of dataSteps()) await prisma.$executeRawUnsafe(step);
}

let counter = 0;
async function makeUser(overrides: Record<string, unknown>) {
  const suffix = counter++;
  return getPrismaClient().user.create({
    data: {
      username: `mig-${suffix}`,
      email: `mig-${suffix}@example.test`,
      timezone: "UTC",
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  counter = 0;
});

describe("the column changes", () => {
  it("adds the Reading documents switch and drops the Correlations one", async () => {
    const rows = await getPrismaClient().$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'app_settings'
         AND column_name IN ('assistant_document_ai_enabled',
                             'assistant_correlations_enabled')`;
    expect(rows.map((r) => r.column_name)).toEqual([
      "assistant_document_ai_enabled",
    ]);
    const settings = await getPrismaClient().appSettings.create({
      data: { id: "singleton" },
    });
    expect(settings.assistantDocumentAiEnabled).toBe(true);
  });
});

describe("one operator Coach switch", () => {
  it("folds a Coach availability of false into the switch and drops the key", async () => {
    const prisma = getPrismaClient();
    await prisma.appSettings.create({
      data: {
        id: "singleton",
        assistantCoachEnabled: true,
        moduleAvailabilityJson: { coach: false, mood: false },
      },
    });
    await runDataSteps();
    await runDataSteps();
    const after = await prisma.appSettings.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(after.assistantCoachEnabled).toBe(false);
    expect(after.moduleAvailabilityJson).toEqual({ mood: false });
  });

  it("drops a Coach availability of true without touching the switch", async () => {
    const prisma = getPrismaClient();
    await prisma.appSettings.create({
      data: {
        id: "singleton",
        assistantCoachEnabled: true,
        moduleAvailabilityJson: { coach: true },
      },
    });
    await runDataSteps();
    const after = await prisma.appSettings.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(after.assistantCoachEnabled).toBe(true);
    expect(after.moduleAvailabilityJson).toEqual({});
  });

  it("leaves an instance with no availability blob alone", async () => {
    const prisma = getPrismaClient();
    await prisma.appSettings.create({
      data: { id: "singleton", assistantCoachEnabled: true },
    });
    await runDataSteps();
    const after = await prisma.appSettings.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(after.assistantCoachEnabled).toBe(true);
    expect(after.moduleAvailabilityJson).toBeNull();
  });
});

describe("hiding the Coach carries over to the AI analysis opt-out", () => {
  it("merges insights: false into every shape of preference blob", async () => {
    const prisma = getPrismaClient();
    const none = await makeUser({ disableCoach: true });
    const some = await makeUser({
      disableCoach: true,
      modulePreferencesJson: { mood: false, mcp: true },
    });
    const junk = await makeUser({
      disableCoach: true,
      modulePreferencesJson: ["not", "an", "object"],
    });
    const before = new Date(Date.now() - 60_000);
    await prisma.user.updateMany({ data: { updatedAt: before } });

    await runDataSteps();
    await runDataSteps();

    const read = (id: string) =>
      prisma.user.findUniqueOrThrow({
        where: { id },
        select: { modulePreferencesJson: true, updatedAt: true },
      });
    expect((await read(none.id)).modulePreferencesJson).toEqual({
      insights: false,
    });
    expect((await read(some.id)).modulePreferencesJson).toEqual({
      mood: false,
      mcp: true,
      insights: false,
    });
    expect((await read(junk.id)).modulePreferencesJson).toEqual({
      insights: false,
    });
    // The optimistic-concurrency token moved, so a form loaded before the
    // upgrade cannot write the old map back.
    expect((await read(some.id)).updatedAt.getTime()).toBeGreaterThan(
      before.getTime(),
    );
  });

  it("leaves everyone who did not hide the Coach untouched", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser({
      disableCoach: false,
      modulePreferencesJson: { mood: false },
    });
    const before = new Date(Date.now() - 60_000);
    await prisma.user.updateMany({ data: { updatedAt: before } });
    await runDataSteps();
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.modulePreferencesJson).toEqual({ mood: false });
    expect(after.updatedAt.getTime()).toBe(before.getTime());
  });
});
