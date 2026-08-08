/**
 * The shape of `prisma/schema.prisma` the two wipe guards read.
 *
 * Both of them ask the same two questions — which models carry a `userId`, and
 * which models the database removes on its own when a row they do delete goes
 * — so the parser answering them lives in one place. Two copies would drift,
 * and a guard that answers from its own private idea of the schema is a guard
 * that can be green for the wrong reason.
 *
 * Deliberately regex-shaped rather than a real parser: it runs inside
 * `pnpm test` with no database and no Prisma engine, and model blocks plus
 * field lines are the most stable syntax in the file. Every consumer asserts a
 * floor on how much it found, so a parser that silently stops matching fails
 * loudly instead of passing vacuously.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Relation {
  /** Target model name. */
  target: string;
  cascade: boolean;
  /** `true` when the relation field is optional (`Model?`). */
  optional: boolean;
}

export interface ModelShape {
  scalars: string[];
  relations: Relation[];
}

export const WIPE_SCHEMA_PATH = join(process.cwd(), "prisma", "schema.prisma");

export function parseWipeSchema(
  schemaPath: string = WIPE_SCHEMA_PATH,
): Map<string, ModelShape> {
  const schema = readFileSync(schemaPath, "utf8");
  const blocks = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map(
    (m) => ({ name: m[1], body: m[2] }),
  );
  const modelNames = new Set(blocks.map((b) => b.name));

  const out = new Map<string, ModelShape>();
  for (const block of blocks) {
    const scalars: string[] = [];
    const relations: Relation[] = [];
    for (const rawLine of block.body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const match = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
      if (!match) continue;
      const [, field, type, isList, isOptional] = match;
      if (modelNames.has(type)) {
        // A list side of a relation carries no column and cannot cascade.
        if (isList) continue;
        relations.push({
          target: type,
          cascade: line.includes("onDelete: Cascade"),
          optional: Boolean(isOptional),
        });
        continue;
      }
      if (isList && type === type.toUpperCase()) {
        // Scalar / enum list column — still a column.
        scalars.push(field);
        continue;
      }
      scalars.push(field);
    }
    out.set(block.name, { scalars, relations });
  }
  return out;
}

/**
 * Every model the database itself removes once the seed models are deleted.
 *
 * A fixpoint over REQUIRED cascade relations: an optional relation survives
 * its parent, so it proves nothing about the row going away. The result
 * includes the seeds.
 */
export function reachedByCascade(
  models: Map<string, ModelShape>,
  seeds: Iterable<string>,
): Set<string> {
  const covered = new Set<string>(seeds);
  for (;;) {
    let grew = false;
    for (const [name, shape] of models) {
      if (covered.has(name)) continue;
      const reached = shape.relations.some(
        (r) => r.cascade && !r.optional && covered.has(r.target),
      );
      if (reached) {
        covered.add(name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return covered;
}
