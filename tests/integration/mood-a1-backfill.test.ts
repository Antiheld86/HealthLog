/**
 * v1.37 — the level-A backfill, read out of the migration and executed.
 *
 * The statement that maps a hundred thousand historical rows onto the
 * pleasantness scale carries its own copy of five numbers, and the runtime map
 * carries the other. Two copies of the same five numbers is a drift waiting to
 * happen, so this test reads the arms back out of the `.sql` file and compares
 * them to `MOOD_A1_MAP` arm by arm — a migration edited without the map, or a
 * map edited without the migration, fails here.
 *
 * The rest of it executes the statement against real Postgres on rows inserted
 * the way legacy rows actually look (`mood_a1 IS NULL`), and asserts the rows,
 * not the fact that the statement ran. It runs a second time and asserts
 * nothing moved: a migration re-applied against a database that has since
 * taken real answers must leave them alone.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { moodA1Map } from "@/lib/validations/mood";
import { getPrismaClient, truncateAllTables } from "./setup";

const MIGRATION_PATH = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "0310_mood_level_a_dimensions",
  "migration.sql",
);

const USER = "user-mood-a1-backfill";

function migrationSql(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

/** The `UPDATE mood_entries … ;` statement, comments stripped. */
function backfillStatement(sql: string): string {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const match = withoutComments.match(/UPDATE\s+mood_entries[\s\S]*?;/i);
  if (!match) {
    throw new Error(
      `No UPDATE statement found in ${MIGRATION_PATH}. The backfill is the point of this test; an absent statement is a failure, not a skip.`,
    );
  }
  return match[0];
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("mood a1 backfill — the statement agrees with the runtime map", () => {
  it("carries one CASE arm per label, with the value the map answers", () => {
    const statement = backfillStatement(migrationSql());
    const arms = [
      ...statement.matchAll(/WHEN\s+'([A-Z_]+)'\s+THEN\s+(\d+)/gi),
    ].map((m) => [m[1], Number(m[2])] as const);

    // An empty match set means the matcher stopped matching, not that the
    // migration is correct. A guard that cannot fail is worse than none.
    expect(arms.length).toBeGreaterThan(0);

    const map = moodA1Map();
    expect(arms.length).toBe(Object.keys(map).length);
    for (const [label, value] of arms) {
      expect(
        map[label],
        `CASE arm '${label}' has no entry in MOOD_A1_MAP`,
      ).toBe(value);
    }
    // And the other direction: a label in the map with no arm would leave
    // those rows NULL after the backfill claimed to have covered them.
    for (const label of Object.keys(map)) {
      expect(
        arms.map(([l]) => l),
        `MOOD_A1_MAP entry '${label}' has no CASE arm in the migration`,
      ).toContain(label);
    }
  });

  it("is guarded on the column being empty, so a re-run cannot overwrite an answer", () => {
    const statement = backfillStatement(migrationSql());
    expect(statement.replace(/\s+/g, " ")).toMatch(
      /WHERE\s+mood_a1\s+IS\s+NULL/i,
    );
  });
});

describe("mood a1 backfill — executed against real rows", () => {
  async function seedLegacyRows() {
    const prisma = getPrismaClient();
    await prisma.user.create({
      data: {
        id: USER,
        username: "mood-a1-backfill",
        email: "mood-a1-backfill@example.test",
        timezone: "Europe/Berlin",
      },
    });

    // Inserted through raw SQL so the columns look exactly like a row written
    // before they existed: every level-A column NULL. Going through Prisma
    // would let a default or a hook fill one in and the test would be
    // proving the seed rather than the migration.
    const rows: Array<[string, string, number, string | null]> = [
      ["legacy-lausig", "LAUSIG", 1, null],
      ["legacy-schlecht", "SCHLECHT", 2, null],
      ["legacy-okay", "OKAY", 3, null],
      ["legacy-gut", "GUT", 4, null],
      ["legacy-super", "SUPER_GUT", 5, null],
      // A tombstoned row is still the user's history and still restorable.
      ["legacy-deleted", "GUT", 4, "2026-05-01T00:00:00.000Z"],
      // A label nothing recognises: no arm matches, so it stays NULL rather
      // than being handed the midpoint.
      ["legacy-unknown", "NOT_A_MOOD", 3, null],
    ];

    for (const [index, [id, mood, score, deletedAt]] of rows.entries()) {
      // An explicit instant per row, one hour apart. `NOW()` would be the
      // transaction's own clock, and two inserts landing on the same tick
      // collide on the `(user_id, date, mood_logged_at)` unique — a seed that
      // fails on a fast machine and passes on a slow one.
      const loggedAt = `2026-05-16T0${index}:00:00.000Z`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO mood_entries (id, user_id, date, mood, score, source, mood_logged_at, synced_at, created_at, updated_at, sync_version, deleted_at)
         VALUES ($1, $2, '2026-05-16', $3, $4, 'MANUAL', $5::timestamptz, NOW(), NOW(), NOW(), 0, $6::timestamptz)`,
        id,
        USER,
        mood,
        score,
        loggedAt,
        deletedAt,
      );
    }

    const before = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM mood_entries WHERE mood_a1 IS NULL`,
    );
    expect(Number(before[0].count)).toBe(rows.length);
    return rows.length;
  }

  it("maps every legacy row onto its anchor and leaves the other four empty", async () => {
    const prisma = getPrismaClient();
    const seeded = await seedLegacyRows();

    const changed = await prisma.$executeRawUnsafe(
      backfillStatement(migrationSql()),
    );
    // Every row but the unknown label — the statement's IN list excludes it.
    expect(changed).toBe(seeded - 1);

    const after = await prisma.moodEntry.findMany({
      where: { userId: USER },
      orderBy: { id: "asc" },
      select: {
        id: true,
        mood: true,
        moodA1: true,
        stressA2: true,
        energyA3: true,
        connectionA4: true,
        stabilityA5: true,
      },
    });
    expect(after).toHaveLength(seeded);

    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get("legacy-lausig")?.moodA1).toBe(1);
    expect(byId.get("legacy-schlecht")?.moodA1).toBe(3);
    expect(byId.get("legacy-okay")?.moodA1).toBe(5);
    expect(byId.get("legacy-gut")?.moodA1).toBe(7);
    expect(byId.get("legacy-super")?.moodA1).toBe(9);
    // A soft-deleted row is backfilled too: it is still in the backup and
    // still comes back from a restore.
    expect(byId.get("legacy-deleted")?.moodA1).toBe(7);
    // An unrecognised label gets nothing rather than a fabricated midpoint.
    expect(byId.get("legacy-unknown")?.moodA1).toBeNull();

    // Nothing derived the other four, on any row.
    for (const row of after) {
      expect(row.stressA2).toBeNull();
      expect(row.energyA3).toBeNull();
      expect(row.connectionA4).toBeNull();
      expect(row.stabilityA5).toBeNull();
    }
  });

  it("changes nothing on a second run, including a value set since the first", async () => {
    const prisma = getPrismaClient();
    await seedLegacyRows();
    const statement = backfillStatement(migrationSql());

    await prisma.$executeRawUnsafe(statement);

    // Somebody answers the slider on one of the backfilled rows, contradicting
    // the mapped value. A re-run must not take that answer away.
    await prisma.moodEntry.update({
      where: { id: "legacy-okay" },
      data: { moodA1: 8 },
    });

    const beforeSecond = await prisma.moodEntry.findMany({
      where: { userId: USER },
      orderBy: { id: "asc" },
      select: { id: true, moodA1: true, updatedAt: true },
    });

    const changedOnSecondRun = await prisma.$executeRawUnsafe(statement);
    expect(changedOnSecondRun).toBe(0);

    const afterSecond = await prisma.moodEntry.findMany({
      where: { userId: USER },
      orderBy: { id: "asc" },
      select: { id: true, moodA1: true, updatedAt: true },
    });
    expect(afterSecond).toEqual(beforeSecond);
    expect(
      afterSecond.find((r) => r.id === "legacy-okay")?.moodA1,
      "the hand-set answer survived the re-run",
    ).toBe(8);
  });
});
