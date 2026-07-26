/**
 * Structural guard — a Prisma enum cannot name a type the migrations never
 * created.
 *
 * `EnvironmentLocationSource` was declared without an `@@map` while migration
 * 0217 created the type as `environment_location_source`. Prisma writes the
 * enum's physical name straight into the SQL, so every insert into
 * `environment_contexts` asked Postgres for `public."EnvironmentLocationSource"`
 * and got `42704`. The module read "0 days recorded" from the day it shipped.
 *
 * Nothing upstream could see it: the type is right in the generated client, the
 * datamodel is internally consistent, and every mocked unit test only ever
 * exercises the logical name. One enum out of forty-nine drifted, and it took a
 * self-hoster reading Postgres error codes to find it.
 *
 * So the physical name is checked against the only other place that states it —
 * the migration SQL. `CREATE TYPE`, `ALTER TYPE … RENAME TO`, and `DROP TYPE`
 * are replayed in migration order, and every declared enum has to land on a
 * type that survives to the end. The `@@map`-present rule is asserted
 * separately, because an unmapped PascalCase enum is the specific mistake that
 * happened and the message should say so rather than "type not found".
 *
 * Limits, stated plainly. This reads SQL text, not a database: it proves the
 * migrations create the type, not that any particular deployment's database
 * matches its migration ledger. It covers enum types only. The comprehensive
 * check — every enum, table, and column name compared against a real migrated
 * Postgres — is `tests/integration/prisma-schema-name-drift.test.ts`, which
 * this guard exists to front-run at unit speed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { readDeclaredSchema } from "./helpers/prisma-schema-names";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../prisma/migrations",
);

const CREATE_TYPE = /CREATE\s+TYPE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w.]+)"?/gi;
const RENAME_TYPE =
  /ALTER\s+TYPE\s+"?([\w.]+)"?\s+RENAME\s+TO\s+"?([\w.]+)"?/gi;
const DROP_TYPE = /DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?"?([\w.]+)"?/gi;

/** `public.foo` and `foo` are the same type; the guard compares bare names. */
function bare(name: string): string {
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
}

/**
 * Statements that are commented out (the rollback recipes several migrations
 * carry in a `--` block) must not count as executed SQL.
 */
function executableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

/** Replay every migration in order and return the types left standing. */
function liveEnumTypes(): Set<string> {
  const live = new Set<string>();
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dir of dirs) {
    let sql: string;
    try {
      sql = readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    const statements = executableSql(sql);

    // Order within one file matters: a migration that drops and recreates a
    // type under a new name has to be replayed as written, so each statement
    // kind is applied at its own offset rather than kind-by-kind.
    const events: Array<{ at: number; apply: () => void }> = [];
    for (const m of statements.matchAll(CREATE_TYPE)) {
      const name = bare(m[1]);
      events.push({ at: m.index, apply: () => void live.add(name) });
    }
    for (const m of statements.matchAll(RENAME_TYPE)) {
      const from = bare(m[1]);
      const to = bare(m[2]);
      events.push({
        at: m.index,
        apply: () => {
          live.delete(from);
          live.add(to);
        },
      });
    }
    for (const m of statements.matchAll(DROP_TYPE)) {
      const name = bare(m[1]);
      events.push({ at: m.index, apply: () => void live.delete(name) });
    }
    for (const event of events.sort((a, b) => a.at - b.at)) event.apply();
  }
  return live;
}

describe("prisma enums — the declared type is the migrated type", () => {
  const { enums } = readDeclaredSchema();

  it("reads the schema (a parser that stopped matching cannot pass vacuously)", () => {
    expect(enums.length).toBeGreaterThan(40);
  });

  it("declares an @@map on every enum", () => {
    const unmapped = enums
      .filter((declared) => declared.mappedName === null)
      .map((declared) => declared.name);
    expect(
      unmapped,
      unmapped.length > 0
        ? `Enum(s) without @@map — Prisma will ask Postgres for the PascalCase ` +
            `type name, which no migration creates: ${unmapped.join(", ")}`
        : undefined,
    ).toEqual([]);
  });

  it("finds the migrated types (a broken replay cannot pass vacuously)", () => {
    expect(liveEnumTypes().size).toBeGreaterThan(40);
  });

  it("points every enum at a type the migrations leave standing", () => {
    const live = liveEnumTypes();
    const missing = enums
      .filter((declared) => !live.has(declared.physicalName))
      .map((declared) => `${declared.name} → "${declared.physicalName}"`);
    expect(
      missing,
      missing.length > 0
        ? `Enum(s) naming a type no migration creates:\n  ${missing.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });
});
