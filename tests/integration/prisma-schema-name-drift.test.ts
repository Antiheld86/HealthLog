/**
 * Every name `prisma/schema.prisma` will put into SQL exists in the migrated
 * database.
 *
 * `EnvironmentLocationSource` shipped with no `@@map` while migration 0217 had
 * created the type as `environment_location_source`. Prisma writes the enum's
 * physical name into the statement, so every insert into `environment_contexts`
 * asked for `public."EnvironmentLocationSource"` and got `42704`. The nightly
 * job failed on every run from the day the module shipped and the screen read
 * "0 days recorded" the whole time.
 *
 * The reason it survived that long is the reason this file is an integration
 * test and not a unit test: generation succeeds, typecheck succeeds, and a
 * mocked Prisma client never emits a type name at all. Only a real migrated
 * Postgres can answer whether the datamodel's physical names exist.
 *
 * So it compares all three name classes Prisma emits — enum type, table,
 * column — against `pg_type` and `information_schema`. One direction only:
 * every DECLARED name must exist physically. The reverse is deliberately not
 * asserted, because a column dropped from the datamodel but left in the
 * database breaks nothing, while a name the client sends and the database
 * lacks breaks every statement that touches it.
 *
 * Also verified here: the environment write the drift actually blocked, once
 * per enum value, against the live type.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  readDeclaredSchema,
  type DeclaredModel,
} from "@/__tests__/helpers/prisma-schema-names";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

async function physicalEnumTypes(): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<Array<{ typname: string }>>`
    SELECT t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typtype = 'e' AND n.nspname = 'public'
  `;
  return new Set(rows.map((row) => row.typname));
}

async function physicalColumns(): Promise<Map<string, Set<string>>> {
  const rows = await prisma.$queryRaw<
    Array<{ table_name: string; column_name: string }>
  >`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `;
  const byTable = new Map<string, Set<string>>();
  for (const { table_name, column_name } of rows) {
    const columns = byTable.get(table_name) ?? new Set<string>();
    columns.add(column_name);
    byTable.set(table_name, columns);
  }
  return byTable;
}

function describeModel(model: DeclaredModel): string {
  return `${model.name} → "${model.physicalName}"`;
}

describe("prisma datamodel — declared names exist in the migrated database", () => {
  const { enums, models } = readDeclaredSchema();

  it("read the datamodel (a parser that stopped matching cannot pass vacuously)", () => {
    expect(enums.length).toBeGreaterThan(40);
    expect(models.length).toBeGreaterThan(80);
    expect(
      models.reduce((sum, model) => sum + model.fields.length, 0),
    ).toBeGreaterThan(500);
  });

  it("has every declared enum type", async () => {
    const physical = await physicalEnumTypes();
    const missing = enums
      .filter((declared) => !physical.has(declared.physicalName))
      .map((declared) => `${declared.name} → "${declared.physicalName}"`);
    expect(
      missing,
      missing.length > 0
        ? `Enum type(s) the database does not have:\n  ${missing.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });

  it("has every declared table", async () => {
    const byTable = await physicalColumns();
    const missing = models
      .filter((model) => !byTable.has(model.physicalName))
      .map(describeModel);
    expect(
      missing,
      missing.length > 0
        ? `Table(s) the database does not have:\n  ${missing.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });

  it("has every declared column", async () => {
    const byTable = await physicalColumns();
    const missing: string[] = [];
    for (const model of models) {
      const columns = byTable.get(model.physicalName);
      if (!columns) continue; // reported by the table assertion above
      for (const field of model.fields) {
        if (!columns.has(field.physicalName)) {
          missing.push(
            `${model.name}.${field.name} → "${model.physicalName}"."${field.physicalName}"`,
          );
        }
      }
    }
    expect(
      missing,
      missing.length > 0
        ? `Column(s) the database does not have:\n  ${missing.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });
});

describe("environment context — the write the enum drift blocked", () => {
  beforeEach(async () => {
    await truncateAllTables(prisma);
  });

  it("stores a row under every EnvironmentLocationSource value", async () => {
    const user = await prisma.user.create({
      data: { username: "env-enum", email: "env-enum@example.test" },
      select: { id: true },
    });

    for (const [index, source] of (
      ["HOME", "TRAVEL", "DEVICE"] as const
    ).entries()) {
      const date = `2026-03-0${index + 1}`;
      await prisma.environmentContext.upsert({
        where: { userId_date: { userId: user.id, date } },
        create: {
          userId: user.id,
          date,
          lat: 52.5,
          lon: 13.4,
          locationLabel: "Somewhere",
          source,
          tempMean: 12.5,
          fetchedAt: new Date(),
        },
        update: { source, tempMean: 12.5 },
      });
    }

    const stored = await prisma.environmentContext.findMany({
      where: { userId: user.id },
      orderBy: { date: "asc" },
      select: { date: true, source: true },
    });
    expect(stored).toEqual([
      { date: "2026-03-01", source: "HOME" },
      { date: "2026-03-02", source: "TRAVEL" },
      { date: "2026-03-03", source: "DEVICE" },
    ]);

    // Idempotent — the nightly lookback re-runs the same days every night.
    await prisma.environmentContext.upsert({
      where: { userId_date: { userId: user.id, date: "2026-03-01" } },
      create: {
        userId: user.id,
        date: "2026-03-01",
        lat: 52.5,
        lon: 13.4,
        locationLabel: "Somewhere",
        source: "HOME",
        fetchedAt: new Date(),
      },
      update: { source: "TRAVEL", tempMean: 14 },
    });
    const reread = await prisma.environmentContext.findMany({
      where: { userId: user.id },
    });
    expect(reread).toHaveLength(3);
    expect(reread.find((row) => row.date === "2026-03-01")?.source).toBe(
      "TRAVEL",
    );
  });

  it("filters on the enum column (the read side sends the type name too)", async () => {
    const user = await prisma.user.create({
      data: { username: "env-enum-read", email: "env-enum-read@example.test" },
      select: { id: true },
    });
    await prisma.environmentContext.create({
      data: {
        userId: user.id,
        date: "2026-04-01",
        lat: 52.5,
        lon: 13.4,
        locationLabel: "Somewhere",
        source: "TRAVEL",
        fetchedAt: new Date(),
      },
    });

    await expect(
      prisma.environmentContext.count({
        where: { userId: user.id, source: { in: ["HOME", "DEVICE"] } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.environmentContext.count({
        where: { userId: user.id, source: "TRAVEL" },
      }),
    ).resolves.toBe(1);
  });
});
