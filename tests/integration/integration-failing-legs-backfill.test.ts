/**
 * Migration 0281's backfill, against rows that actually carry the old value.
 *
 * A migration test container starts EMPTY, so `pnpm db:migrate:deploy` proves
 * only that the statements parse and apply — the backfill's `WHERE failing_leg
 * IS NOT NULL` matches nothing and a broken expression would sail through
 * green. Every existing self-hoster runs it against rows that DO carry a leg,
 * and those are the only rows it exists for: a connection that has been failing
 * for weeks must come out of the migration still remembering which leg broke,
 * or the deploy silently forgives every live failure on the instance.
 *
 * The statement is read out of the migration file rather than restated here, so
 * this cannot drift into testing a copy that no longer matches what ships.
 *
 * On the raw-SQL convention: every value-bearing statement below binds through
 * positional `$N` placeholders. The one spliced string is the migration's own
 * `UPDATE`, read from a committed file in this repository — a file literal, not
 * an input, and the exact text the deploy runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/0281_integration_failing_legs_and_healthkit_trigger/migration.sql",
  ),
  "utf8",
);

/**
 * The one `UPDATE` in the migration, lifted verbatim. Anchoring on the
 * statement keyword rather than a line number keeps the extraction stable
 * against comment edits above it.
 */
function backfillStatement(): string {
  const start = MIGRATION_SQL.indexOf('UPDATE "integration_statuses"');
  expect(start).toBeGreaterThan(-1);
  const end = MIGRATION_SQL.indexOf(";", start);
  expect(end).toBeGreaterThan(start);
  return MIGRATION_SQL.slice(start, end + 1);
}

const USER_ID = "user-failing-legs-backfill";

async function seedUser() {
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "backfill-subject",
      passwordHash: "x",
    },
  });
}

describe("migration 0281 — failing_leg backfill", () => {
  beforeEach(async () => {
    const client = getPrismaClient();
    await truncateAllTables(client);
    // Re-create the pre-migration column so a row can be seeded in the shape
    // the migration will actually meet on a live instance.
    await client.$executeRawUnsafe(
      'ALTER TABLE "integration_statuses" ADD COLUMN "failing_leg" TEXT',
    );
    await seedUser();
  });

  afterEach(async () => {
    await getPrismaClient().$executeRawUnsafe(
      'ALTER TABLE "integration_statuses" DROP COLUMN IF EXISTS "failing_leg"',
    );
  });

  async function seedRow(integration: string, failingLeg: string | null) {
    await getPrismaClient().$executeRawUnsafe(
      `INSERT INTO "integration_statuses"
         (id, user_id, integration, state, failing_leg, failing_legs, created_at, updated_at)
       VALUES ($1, $2, $3, 'error_transient', $4, NULL, NOW(), NOW())`,
      `st-${integration}`,
      USER_ID,
      integration,
      failingLeg,
    );
  }

  async function readLegs(integration: string) {
    const rows = await getPrismaClient().$queryRawUnsafe<
      Array<{ failing_legs: unknown }>
    >(
      'SELECT failing_legs FROM "integration_statuses" WHERE integration = $1',
      integration,
    );
    return rows[0]?.failing_legs;
  }

  it("carries an attributed leg forward as a one-element set", async () => {
    await seedRow("withings", "sleep");

    await getPrismaClient().$executeRawUnsafe(backfillStatement());

    // The whole point of the migration: an instance that has been failing on
    // its sleep leg for weeks still knows that after the deploy. Losing it
    // would let the next healthy leg clear the error on the first cron tick.
    expect(await readLegs("withings")).toEqual(["sleep"]);
  });

  it("leaves an unattributed row alone", async () => {
    await seedRow("oura", null);

    await getPrismaClient().$executeRawUnsafe(backfillStatement());

    // NULL and `[]` both read as "failing, but unattributed" — the code's
    // pre-existing semantics, under which any success clears. Writing `[]`
    // here would be churn that changes nothing.
    expect(await readLegs("oura")).toBeNull();
  });

  it("is safe to run twice", async () => {
    await seedRow("polar", "vitals");

    const statement = backfillStatement();
    await getPrismaClient().$executeRawUnsafe(statement);
    await getPrismaClient().$executeRawUnsafe(statement);

    // A re-run must not nest the array into `[["vitals"]]`. Migrations get
    // re-applied by hand more often than anyone plans for.
    expect(await readLegs("polar")).toEqual(["vitals"]);
  });
});
