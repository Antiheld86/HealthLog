/**
 * Pair guard binding `prisma/schema.prisma`'s `MoodEntry`,
 * `MoodEntryTagLink` and `MoodContext` models to the disaster-recovery backup
 * selects.
 *
 * The sibling of `measurement-backup-completeness.test.ts`, written as its own
 * file rather than as a second describe inside it, because that guard's own
 * note asks for model-by-model growth and one file per model keeps every
 * failure message about one model.
 *
 * The failure it exists to catch, stated by the defect that prompted it: the
 * mood payload carried `id, date, mood, score, tags, source, loggedAt,
 * externalId, deletedAt, factors` and nothing else. The free-text note, the
 * row's timezone and the last-writer-wins counter were selected by the query
 * and written to no payload, so a restored entry came back without its text,
 * read its day boundaries under the legacy Europe/Berlin assumption, and lost
 * the next sync round to a paired device still holding a higher counter. The
 * backup validation schema is `.passthrough()`, so nothing complained at parse
 * time either. Nothing here was a wrong value; every one of them was silence.
 *
 * Both ends of the comparison are literals — a Prisma model block and a named
 * select object — so the matcher is exact. Every matcher also asserts a
 * non-zero match count: an empty match set fails rather than passing quietly,
 * which is how the bearer-scope guard stayed green for months while matching
 * nothing at all.
 *
 * Mutation check: comment out `tz: true` in `MOOD_ENTRY_BACKUP_SELECT` and
 * this goes red naming that column; add a scalar to the model without adding
 * it to the select and it goes red naming the new one; rename the mapper's
 * `moodEntry` parameter and the serialization assertion goes red on all of
 * them at once. The same three hold for `MOOD_CONTEXT_BACKUP_SELECT` and the
 * `moodContext` mapper parameter beside it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = process.cwd();
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const BACKUP_BUILDER = join(
  ROOT,
  "src",
  "lib",
  "export",
  "full-backup-payload.ts",
);

/**
 * Columns the backup is correct to omit, each with the reason. The reasons are
 * length-checked below: an exclusion is a claim, and a claim needs saying.
 */
const EXCLUDED_MOOD_ENTRY_COLUMNS: Record<string, string> = {
  userId: "user-scoped backup; owner is re-derived from the restoring account",
};

const EXCLUDED_MOOD_CONTEXT_COLUMNS: Record<string, string> = {
  moodEntryId:
    "re-bound to the restored parent row's id; the context rides inside its entry",
  userId: "user-scoped backup; owner is re-derived from the restoring account",
  createdAt:
    "the sub-row's own bookkeeping stamp; the entry carries the moment the person logged the day, and the context has nothing separate to say about when it was typed",
  updatedAt:
    "the sub-row's own bookkeeping stamp, moved by every write; a restore re-stamps it and nothing reads the old value",
};

const EXCLUDED_TAG_LINK_COLUMNS: Record<string, string> = {
  moodEntryId: "re-bound to the restored parent row's id, never carried",
  moodTagId:
    "the link travels by the tag's key; a source-instance id need not exist in the target catalogue",
  createdAt:
    "the link's own row stamp; the entry carries the moment the person logged it, and a key-only BINARY tag has nowhere to put a second one",
};

function modelBlock(schema: string, model: string): string {
  const start = schema.indexOf(`model ${model} {`);
  expect(start, `model ${model} not found`).toBeGreaterThan(-1);
  const end = schema.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return schema.slice(start, end);
}

/** Names of every `model` block, so relation fields can be told apart. */
function declaredModels(schema: string): Set<string> {
  const out = new Set<string>();
  for (const m of schema.matchAll(/^model\s+([A-Za-z_]\w*)\s*\{/gm)) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Scalar (column-backed) fields of a model block: everything that is not a
 * relation to another model. Enums and native scalars both map to columns and
 * therefore both belong in a backup.
 */
function scalarFields(block: string, models: Set<string>): string[] {
  const fields: string[] = [];
  for (const rawLine of block.split("\n").slice(1)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const m = /^([a-zA-Z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?/.exec(line);
    if (!m) continue;
    const [, name, type, isList] = m;
    if (isList) continue;
    if (models.has(type)) continue;
    if (line.includes("@relation")) continue;
    fields.push(name);
  }
  return fields;
}

/** Keys of a named `const <NAME> = {` select literal. */
function selectFields(source: string, constant: string): string[] {
  const start = source.indexOf(`const ${constant} = {`);
  expect(start, `${constant} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^ {2}([a-zA-Z_$][\w$]*): true,$/gm)].map(
    (m) => m[1],
  );
}

/**
 * The builder with its comment lines removed.
 *
 * Every matcher below runs against this rather than against the raw file,
 * because prose describing the defect reads exactly like the defect: the first
 * draft of this guard went red on its own explanation of the filter it exists
 * to forbid. Whole comment lines only — a trailing comment after code is left
 * alone, which is safe here because the only risk it carries is a matcher
 * accepting a column named in prose, and the select comparison beside it is
 * literal either way.
 */
function stripCommentLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*")
      );
    })
    .join("\n");
}

/**
 * Columns either serialization arm actually reads off the mapped row.
 *
 * The capture is the RIGHT-hand side — the column — not the payload key, which
 * matters here in a way it did not for `Measurement`: the mood payload renames
 * `moodLoggedAt` to `loggedAt` on the wire, so a left-hand matcher would report
 * the column as dropped while the value rides perfectly well.
 *
 * The two arms share one restorable wire format, so this is a union and
 * therefore a weaker claim than the select comparison: it catches a column that
 * is selected and then written to neither payload, not one carried by only a
 * single arm.
 */
function serialisedFields(source: string, variable: string): Set<string> {
  const matches = [
    ...source.matchAll(
      new RegExp(`[:(,]\\s*${variable}\\.([a-zA-Z_$][\\w$]*)`, "g"),
    ),
  ];
  expect(
    matches.length,
    `no \`${variable}.<column>\` reads found — the mapper parameter was renamed and this matcher now proves nothing`,
  ).toBeGreaterThan(0);
  return new Set(matches.map((m) => m[1]));
}

describe("mood backup completeness", () => {
  const schema = readFileSync(SCHEMA, "utf8");
  const source = stripCommentLines(readFileSync(BACKUP_BUILDER, "utf8"));
  const models = declaredModels(schema);

  const entryColumns = scalarFields(modelBlock(schema, "MoodEntry"), models);
  const entrySelected = selectFields(source, "MOOD_ENTRY_BACKUP_SELECT");
  const linkColumns = scalarFields(
    modelBlock(schema, "MoodEntryTagLink"),
    models,
  );
  const linkSelected = selectFields(source, "MOOD_ENTRY_TAG_LINK_SELECT");
  const contextColumns = scalarFields(
    modelBlock(schema, "MoodContext"),
    models,
  );
  const contextSelected = selectFields(source, "MOOD_CONTEXT_BACKUP_SELECT");

  it("parses both ends into a plausible shape", () => {
    expect(models.size).toBeGreaterThan(50);
    expect(entryColumns.length).toBeGreaterThan(10);
    expect(entryColumns).toContain("noteEncrypted");
    expect(entryColumns).toContain("syncVersion");
    expect(entryColumns).not.toContain("user");
    expect(entryColumns).not.toContain("tagLinks");
    expect(entrySelected.length).toBeGreaterThan(10);

    expect(linkColumns).toEqual(
      expect.arrayContaining([
        "moodEntryId",
        "moodTagId",
        "createdAt",
        "rating",
      ]),
    );
    expect(linkColumns).not.toContain("moodEntry");
    expect(linkColumns).not.toContain("moodTag");
    expect(linkSelected.length).toBeGreaterThan(0);

    expect(contextColumns.length).toBeGreaterThan(15);
    expect(contextColumns).toContain("notesEncrypted");
    expect(contextColumns).toContain("eventAt");
    expect(contextColumns).not.toContain("moodEntry");
    expect(contextColumns).not.toContain("user");
    expect(contextSelected.length).toBeGreaterThan(15);
  });

  it("the backup select covers every MoodContext column", () => {
    const missing = contextColumns.filter(
      (c) =>
        !contextSelected.includes(c) && !(c in EXCLUDED_MOOD_CONTEXT_COLUMNS),
    );

    if (missing.length > 0) {
      const report = missing.map((c) => `  ❌ ${c}`).join("\n");
      throw new Error(
        `MOOD_CONTEXT_BACKUP_SELECT omits ${missing.length} column(s) of the MoodContext model:\n${report}\n\n` +
          "A disaster-recovery restore brings these back as NULL, which reads " +
          "as an answer nobody gave rather than as a lost one. Add each to " +
          "the select and to both serialization arms, extend " +
          "`moodContextSchema` in the backup validations and the restore " +
          "write — or add it to EXCLUDED_MOOD_CONTEXT_COLUMNS with the reason " +
          "the backup is correct to drop it.",
      );
    }
  });

  it("every selected MoodContext column reaches a serialized payload", () => {
    const emitted = serialisedFields(source, "moodContext");
    const dropped = contextSelected.filter((c) => !emitted.has(c));

    if (dropped.length > 0) {
      const report = dropped.map((c) => `  ❌ ${c}`).join("\n");
      throw new Error(
        `${dropped.length} selected MoodContext column(s) reach neither serialization arm:\n${report}\n\n` +
          "The query pays for them and no payload carries them, so a restore " +
          "cannot put them back.",
      );
    }
  });

  it("the backup select covers every MoodEntry column", () => {
    const missing = entryColumns.filter(
      (c) => !entrySelected.includes(c) && !(c in EXCLUDED_MOOD_ENTRY_COLUMNS),
    );

    if (missing.length > 0) {
      const report = missing.map((c) => `  ❌ ${c}`).join("\n");
      throw new Error(
        `MOOD_ENTRY_BACKUP_SELECT omits ${missing.length} column(s) of the MoodEntry model:\n${report}\n\n` +
          "A disaster-recovery restore brings these back at their column " +
          "default. Add each to the select and to both serialization arms, " +
          "extend `moodEntrySchema` and the restore write — or add it to " +
          "EXCLUDED_MOOD_ENTRY_COLUMNS with the reason the backup is correct " +
          "to drop it.",
      );
    }
  });

  it("every selected MoodEntry column reaches a serialized payload", () => {
    const emitted = serialisedFields(source, "moodEntry");
    const dropped = entrySelected.filter((c) => !emitted.has(c));

    if (dropped.length > 0) {
      const report = dropped.map((c) => `  ❌ ${c}`).join("\n");
      throw new Error(
        `${dropped.length} selected MoodEntry column(s) reach neither serialization arm:\n${report}\n\n` +
          "The query pays for them and no payload carries them, so a restore " +
          "cannot put them back. Emit each from the disaster-recovery arm " +
          "(and, where it is readable and not a tombstone, from the portable " +
          "arm too).",
      );
    }
  });

  it("the tag-link select covers every MoodEntryTagLink column", () => {
    const missing = linkColumns.filter(
      (c) => !linkSelected.includes(c) && !(c in EXCLUDED_TAG_LINK_COLUMNS),
    );
    expect(
      missing,
      `MOOD_ENTRY_TAG_LINK_SELECT omits MoodEntryTagLink column(s): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every selected tag-link column reaches a serialized payload", () => {
    const emitted = serialisedFields(source, "tagLink");
    const dropped = linkSelected.filter((c) => !emitted.has(c));
    expect(
      dropped,
      `selected but serialized by neither arm: ${dropped.join(", ")}`,
    ).toEqual([]);
  });

  it("both structured-tag arms are carried, not just the rated one", () => {
    // The defect this file was written for: the tag-link read carried a
    // filter, and a BINARY link's rating is NULL by definition, so every
    // present/absent tag — the kind most people pick — was excluded from the
    // file and could not come back from it. The claim is therefore about the
    // read itself: it takes the links whole, unfiltered.
    //
    // Asserted on booleans rather than on the file contents so a failure reads
    // as one line instead of printing the whole builder back.
    const tagLinkRead = /tagLinks:\s*\{([\s\S]*?)\}/.exec(source);
    expect(
      tagLinkRead,
      "no `tagLinks:` read found in the backup builder — this matcher proves nothing",
    ).not.toBeNull();
    expect(
      /where/.test(tagLinkRead![1]),
      "the tag-link read filters again; a filter here is what dropped every BINARY link from the backup",
    ).toBe(false);
    expect(
      source.includes("structuredTags"),
      "no `structuredTags` key in the payload — the BINARY links have no carrier",
    ).toBe(true);
  });

  it("the exclusion lists carry no stale entry", () => {
    for (const [column, reason] of Object.entries(
      EXCLUDED_MOOD_ENTRY_COLUMNS,
    )) {
      expect(
        entryColumns,
        `${column} is excluded but is no longer a MoodEntry column`,
      ).toContain(column);
      expect(reason.length).toBeGreaterThan(20);
    }
    for (const [column, reason] of Object.entries(EXCLUDED_TAG_LINK_COLUMNS)) {
      expect(
        linkColumns,
        `${column} is excluded but is no longer a MoodEntryTagLink column`,
      ).toContain(column);
      expect(reason.length).toBeGreaterThan(20);
    }
    for (const [column, reason] of Object.entries(
      EXCLUDED_MOOD_CONTEXT_COLUMNS,
    )) {
      expect(
        contextColumns,
        `${column} is excluded but is no longer a MoodContext column`,
      ).toContain(column);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
