/**
 * Every reference a restore writes has to stay inside the account it writes.
 *
 * A backup file names ids: a custom mood tag names its category, an illness
 * names its parent condition, a link names the document and the episode it
 * joins. The restore writes those ids back as given, and a foreign key only
 * proves the row they point at exists, not whose it is. So a file edited by
 * hand, or an upload whose owner is simply what the file says it is, could
 * attach the restored account's rows to rows of another account on the same
 * host: a custom tag filed under somebody else's category, a note linked to
 * somebody else's document. Several of the restore's writes (the tag and
 * category upserts keyed on a globally unique `key`, for one) never even look
 * at the owner.
 *
 * Checking each write site by hand is the approach that keeps missing one, so
 * the check is derived from the schema instead. Every single-column foreign key
 * is read from the database catalogue, and two shapes are held:
 *
 *   - a table with `user_id` pointing at another table with `user_id`: a row of
 *     the restored account may not point at a row another account owns;
 *   - a link table without `user_id` joining two such tables: a link whose one
 *     end is the restored account's may not have its other end in another
 *     account.
 *
 * A NULL owner on the far end is a shared catalogue row (a seeded tag) and is
 * allowed. The counts are taken twice inside the restore transaction, before
 * the first delete and after the last write, and the restore is refused when
 * any count went up: the host may have legitimate cross-account links of its
 * own (a shared record), and the question is only whether THIS restore added
 * one. Refusing throws, which rolls the whole transaction back.
 */
import type { Prisma } from "@/generated/prisma/client";

type Db = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$queryRaw">;

/** One foreign key, or one pair of them through a link table. */
export interface TenantEdge {
  /** Readable name for the refusal: `child.column -> parent`. */
  name: string;
  /** The counting query; `$1` is the owner id. */
  sql: string;
}

/**
 * Identifiers read from the catalogue are spliced into SQL, so each is held
 * to this before use (the whitelist-splice rule for `$queryRawUnsafe`).
 */
const IDENT = /^[a-z_][a-z0-9_]*$/;

interface ForeignKeyRow {
  child: string;
  child_col: string;
  parent: string;
  parent_col: string;
  child_owned: boolean;
  parent_owned: boolean;
}

/** Thrown inside the restore transaction; rolls it back. */
export class ForeignReferenceError extends Error {
  readonly edges: string[];
  constructor(edges: string[]) {
    super(
      `The backup references records that belong to another account (${edges.join(", ")}). Nothing was changed.`,
    );
    this.name = "ForeignReferenceError";
    this.edges = edges;
  }
}

export async function listTenantEdges(db: Db): Promise<TenantEdge[]> {
  const rows = await db.$queryRaw<ForeignKeyRow[]>`
    SELECT
      child.relname AS child,
      ca.attname AS child_col,
      parent.relname AS parent,
      pa.attname AS parent_col,
      EXISTS (
        SELECT 1 FROM pg_attribute x
        WHERE x.attrelid = c.conrelid AND x.attname = 'user_id'
          AND NOT x.attisdropped
      ) AS child_owned,
      EXISTS (
        SELECT 1 FROM pg_attribute x
        WHERE x.attrelid = c.confrelid AND x.attname = 'user_id'
          AND NOT x.attisdropped
      ) AS parent_owned
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.contype = 'f'
      AND array_length(c.conkey, 1) = 1
      AND n.nspname = current_schema()
    ORDER BY child.relname, ca.attname
  `;

  const safe = rows.filter((row) =>
    [row.child, row.child_col, row.parent, row.parent_col].every((id) =>
      IDENT.test(id),
    ),
  );
  if (safe.length !== rows.length) {
    // Never silently narrower than the schema: a check that quietly skips a
    // table is the kind that stays green because it matched nothing.
    throw new Error(
      "Tenant check: a foreign key has an identifier outside [a-z0-9_]",
    );
  }

  const edges: TenantEdge[] = [];
  for (const fk of safe) {
    if (!fk.child_owned || !fk.parent_owned) continue;
    edges.push({
      name: `${fk.child}.${fk.child_col} -> ${fk.parent}`,
      sql:
        `SELECT count(*)::int AS n FROM "${fk.child}" c ` +
        `JOIN "${fk.parent}" p ON p."${fk.parent_col}" = c."${fk.child_col}" ` +
        `WHERE c.user_id = $1 AND p.user_id IS NOT NULL AND p.user_id <> $1`,
    });
  }

  // Link tables: no owner of their own, two or more keys into owned tables.
  const byChild = new Map<string, ForeignKeyRow[]>();
  for (const fk of safe) {
    if (fk.child_owned || !fk.parent_owned) continue;
    const list = byChild.get(fk.child) ?? [];
    list.push(fk);
    byChild.set(fk.child, list);
  }
  for (const [child, fks] of byChild) {
    if (fks.length < 2) continue;
    for (const near of fks) {
      for (const far of fks) {
        if (near === far) continue;
        edges.push({
          name: `${child}.${near.child_col} / ${child}.${far.child_col} -> ${far.parent}`,
          sql:
            `SELECT count(*)::int AS n FROM "${child}" l ` +
            `JOIN "${near.parent}" a ON a."${near.parent_col}" = l."${near.child_col}" ` +
            `JOIN "${far.parent}" b ON b."${far.parent_col}" = l."${far.child_col}" ` +
            `WHERE a.user_id = $1 AND b.user_id IS NOT NULL AND b.user_id <> $1`,
        });
      }
    }
  }
  return edges;
}

/** How many references from `ownerId`'s rows leave the account, per edge. */
export async function countForeignReferences(
  db: Db,
  ownerId: string,
  edges: readonly TenantEdge[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const [row] = await db.$queryRawUnsafe<Array<{ n: number }>>(
      edge.sql,
      ownerId,
    );
    counts.set(edge.name, row?.n ?? 0);
  }
  return counts;
}

/** Throw when any edge carries more foreign references than it did before. */
export function assertNoNewForeignReferences(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): void {
  const grown = [...after]
    .filter(([name, n]) => n > (before.get(name) ?? 0))
    .map(([name]) => name);
  if (grown.length > 0) throw new ForeignReferenceError(grown);
}
