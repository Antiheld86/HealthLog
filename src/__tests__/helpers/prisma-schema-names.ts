/**
 * A minimal reader for the physical names `prisma/schema.prisma` declares.
 *
 * Prisma emits three kinds of identifier straight into the SQL it sends: the
 * enum type name, the table name, and the column name. Each one is the `@@map`
 * / `@map` value when present and the declared name verbatim when absent. If
 * any of the three names something the database does not have, the statement
 * dies at the driver with `42704` / `42P01` / `42703` — and nothing earlier in
 * the pipeline can see it, because generation, typecheck, and every mocked
 * unit test read the logical name only.
 *
 * Consumers: `prisma-enum-mapping-guard.test.ts` (the convention, no database)
 * and `tests/integration/prisma-schema-name-drift.test.ts` (the physical
 * comparison against a migrated Postgres).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../prisma/schema.prisma",
);

export interface DeclaredEnum {
  /** The enum name in the datamodel. */
  name: string;
  /** The `@@map` value, or null when the declaration carries none. */
  mappedName: string | null;
  /** The name Prisma puts in the SQL — `@@map` when present, else `name`. */
  physicalName: string;
  /** The declared members, in declaration order. */
  values: string[];
}

export interface DeclaredField {
  name: string;
  /** The `@map` value, or null when the field carries none. */
  mappedName: string | null;
  /** The column name Prisma puts in the SQL. */
  physicalName: string;
}

export interface DeclaredModel {
  name: string;
  mappedName: string | null;
  /** The table name Prisma puts in the SQL. */
  physicalName: string;
  /** Scalar + enum fields only — relation fields carry no column. */
  fields: DeclaredField[];
}

export interface DeclaredSchema {
  enums: DeclaredEnum[];
  models: DeclaredModel[];
}

const BLOCK_MAP = /^\s*@@map\("([^"]+)"\)/m;
const FIELD_MAP = /@map\("([^"]+)"\)/;
/** `name  Type[]?  @attr…` — the two leading tokens are what matters. */
const FIELD_LINE = /^\s*(\w+)\s+(\w+)(?:\[\])?\??\s*(.*)$/;

/** Drop `//` and `///` lines so prose can never read as a declaration. */
function stripComments(block: string): string {
  return block
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * Read the datamodel. Deliberately regex-shaped rather than a real parser: the
 * guard has to run inside `pnpm test` with no database and no Prisma engine,
 * and the three declarations it reads (`enum`, `model`, field lines) are the
 * most stable syntax in the file. Both consumers assert a floor on how much
 * they found, so a parser that silently stops matching fails loudly instead of
 * passing vacuously.
 */
export function readDeclaredSchema(
  schemaPath: string = SCHEMA_PATH,
): DeclaredSchema {
  const source = readFileSync(schemaPath, "utf8");
  const enums: DeclaredEnum[] = [];
  const rawModels: Array<{ name: string; body: string }> = [];

  const block = /^(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (let m = block.exec(source); m !== null; m = block.exec(source)) {
    const [, kind, name, body] = m;
    const clean = stripComments(body);
    const mappedName = BLOCK_MAP.exec(clean)?.[1] ?? null;
    if (kind === "enum") {
      // A member is a bare identifier on its own line; `@@map` and any
      // trailing comment are already gone (block attributes start with `@`,
      // comment lines were stripped above).
      const values = clean
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, "").trim())
        .filter((line) => /^\w+$/.test(line));
      enums.push({
        name,
        mappedName,
        physicalName: mappedName ?? name,
        values,
      });
    } else {
      rawModels.push({ name, body: clean });
    }
  }

  const modelNames = new Set(rawModels.map((m) => m.name));

  const models = rawModels.map(({ name, body }) => {
    const mappedName = BLOCK_MAP.exec(body)?.[1] ?? null;
    const fields: DeclaredField[] = [];
    for (const line of body.split("\n")) {
      if (/^\s*@@/.test(line)) continue;
      const match = FIELD_LINE.exec(line);
      if (!match) continue;
      const [, fieldName, baseType, rest] = match;
      // A field whose type is another model is a relation, not a column. The
      // back-reference side carries no `@relation` attribute at all, so the
      // type is what decides it — keying on `@relation` would miss half.
      if (modelNames.has(baseType)) continue;
      const fieldMapped = FIELD_MAP.exec(rest)?.[1] ?? null;
      fields.push({
        name: fieldName,
        mappedName: fieldMapped,
        physicalName: fieldMapped ?? fieldName,
      });
    }
    return { name, mappedName, physicalName: mappedName ?? name, fields };
  });

  return { enums, models };
}
