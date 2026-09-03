/**
 * The column-reader sweep (`scripts/audit-column-readers.ts`) is a review tool,
 * not a gate — the whole-program question it asks cannot be answered exactly
 * without type information, so a human reads its output. But the matcher
 * UNDERNEATH it can be pinned exactly, and until this file existed it was not:
 * the sweep counted every `<field>:` key as a write, so a column that is only
 * ever filtered on (`where: { ticketHash } `) looked written-but-never-read.
 * Every finding it produced was that one mistake, which is the failure mode a
 * review tool cannot survive — an operator who has dismissed twelve false
 * alarms dismisses the thirteenth finding too.
 *
 * So this file feeds the matcher a fixture whose right answers are known by
 * construction and asserts the classification, one case per defect class. It
 * does NOT assert anything about the real schema; that stays a human read.
 */
import { describe, expect, it } from "vitest";
import {
  categorise,
  countUsage,
  emptyIndex,
  indexSource,
  parseSchema,
  type Category,
} from "../../scripts/audit-column-readers";

const SCHEMA = `
model Widget {
  id             String   @id @default(cuid())
  /// Looked up by, never written by application code.
  lookupOnly     String   @map("lookup_only")
  /// Stamped by a cron and used as that cron's discovery predicate.
  backfilledAt   DateTime? @map("backfilled_at")
  /// Written, and nothing consumes it.
  writeOnlyNote  String?  @map("write_only_note")
  /// Written and read back.
  consumedValue  Int?     @map("consumed_value")
  /// Reached only through a select projection.
  projectedValue Int?     @map("projected_value")
  /// Assembled into a payload variable before the Prisma call.
  builtViaPayload String? @map("built_via_payload")
  /// Pushed into a typed payload array.
  builtViaPush   String?  @map("built_via_push")
  /// Written and read by raw SQL only.
  rawSqlColumn   Int?     @map("raw_sql_column")
  /// Nothing anywhere touches this one.
  orphanColumn   String?  @map("orphan_column")
  /// @internal: bookkeeping for a cron; never surfaced.
  internalColumn String?  @map("internal_column")
  /// @pending-consumer(#123) — the client reads this from a later build.
  awaitedColumn  String?  @map("awaited_column")
  ownerId        String   @map("owner_id")

  owner Owner @relation(fields: [ownerId], references: [id])

  @@map("widgets")
}

model Owner {
  id String @id @default(cuid())
}
`;

/**
 * Deliberately written the way the application writes: `where` filters beside
 * `data` payloads, an `orderBy`, an `include`, a payload assembled into a
 * variable, and a `.push` builder. Every one of those was a write to the old
 * matcher.
 */
const SOURCE = `
import { prisma, type Prisma } from "@/lib/db";

export async function findWidget(token: string) {
  return prisma.widget.findUnique({
    where: { lookupOnly: token },
    orderBy: { backfilledAt: "desc" },
    include: { owner: true },
    select: { projectedValue: true },
  });
}

export async function claimWidget(id: string, note: string) {
  const row = await prisma.widget.update({
    where: { id },
    data: { writeOnlyNote: note, consumedValue: 1, projectedValue: 2 },
  });
  return row.consumedValue;
}

export async function sweepWidgets() {
  const stale = await prisma.widget.findMany({
    where: { backfilledAt: null },
  });
  for (const widget of stale) {
    await prisma.widget.update({
      where: { id: widget.id },
      data: { backfilledAt: new Date() },
    });
  }
}

export async function savePreferences(input: { label?: string }) {
  const updates: Prisma.WidgetUpdateInput = {};
  if (input.label !== undefined) updates.builtViaPayload = input.label;
  await prisma.widget.update({ where: { id: "x" }, data: updates });
}

export async function seedWidgets(labels: string[]) {
  const rows: Prisma.WidgetCreateManyInput[] = [];
  for (const label of labels) {
    rows.push({ ownerId: "o", lookupOnly: label, builtViaPush: label });
  }
  await prisma.widget.createMany({ data: rows });
}

export async function bumpRawSql(id: string) {
  await prisma.$executeRaw\`
    UPDATE widgets SET raw_sql_column = raw_sql_column + 1 WHERE id = \${id}
  \`;
}
`;

function classify() {
  const index = indexSource(SOURCE, emptyIndex());
  const out = new Map<string, Category>();
  for (const field of parseSchema(SCHEMA)) {
    if (field.model !== "Widget") continue;
    out.set(field.name, categorise(field, countUsage(index, field)));
  }
  return out;
}

describe("column-reader audit matcher", () => {
  const verdicts = classify();

  it("does not mistake a `where:` filter for a write", () => {
    // The exact defect: `lookupOnly` is filtered on, and written only inside a
    // `rows.push({...})` builder. It must never come back as write-no-reader,
    // the verdict the old matcher gave to all twelve of its findings.
    expect(verdicts.get("lookupOnly")).not.toBe("write-no-reader");
    expect(verdicts.get("lookupOnly")).toBe("query-only");
  });

  it("reads a cron's stamp-and-discover column as query-only, not unread", () => {
    expect(verdicts.get("backfilledAt")).toBe("query-only");
  });

  it("still reports a genuine write with no consumer", () => {
    expect(verdicts.get("writeOnlyNote")).toBe("write-no-reader");
  });

  it("reports a column nothing in the tree touches", () => {
    expect(verdicts.get("orphanColumn")).toBe("unwired");
  });

  it("counts property access and select projection as consumption", () => {
    expect(verdicts.get("consumedValue")).toBe("consumed");
    expect(verdicts.get("projectedValue")).toBe("consumed");
  });

  it("follows a payload assembled before the Prisma call", () => {
    // `updates.builtViaPayload = …` then `data: updates`, and
    // `rows.push({ builtViaPush })` then `data: rows`. Miss either and the
    // whole settings and import layer reads as write-less columns.
    const index = indexSource(SOURCE, emptyIndex());
    const fields = parseSchema(SCHEMA);
    for (const name of ["builtViaPayload", "builtViaPush"]) {
      const field = fields.find((f) => f.name === name)!;
      expect(countUsage(index, field).writes).toBeGreaterThan(0);
    }
  });

  it("credits raw SQL against the mapped column name", () => {
    const index = indexSource(SOURCE, emptyIndex());
    const field = parseSchema(SCHEMA).find((f) => f.name === "rawSqlColumn")!;
    expect(countUsage(index, field).writes).toBeGreaterThan(0);
  });

  it("lets an annotation outrank the matcher", () => {
    expect(verdicts.get("internalColumn")).toBe("annotated-internal");
    expect(verdicts.get("awaitedColumn")).toBe("annotated-pending");
  });

  it("leaves a relation's foreign key to the relation", () => {
    // Prisma writes `ownerId` through `connect` and reads it back through
    // `owner`; neither appears under the scalar's own name.
    expect(verdicts.get("ownerId")).toBe("relation-backed");
  });

  it("keeps `orderBy` and `include` out of the write set", () => {
    const index = indexSource(SOURCE, emptyIndex());
    expect(index.writeKeys.get("orderBy") ?? 0).toBe(0);
    expect(index.writeKeys.get("include") ?? 0).toBe(0);
    expect(index.queryKeys.get("backfilledAt") ?? 0).toBeGreaterThan(0);
  });

  it("masks comments and string bodies out of the code it reads", () => {
    const index = indexSource(
      `const s = "data: { ghostColumn: 1 }";\n// data: { ghostColumn: 2 }\n`,
      emptyIndex(),
    );
    expect(index.writeKeys.get("ghostColumn") ?? 0).toBe(0);
  });
});
