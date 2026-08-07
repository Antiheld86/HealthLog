/**
 * Structural guard binding `prisma/schema.prisma` to the "Delete All Data"
 * wipe plan.
 *
 * The failure it exists to catch: a model is added to the schema, it is
 * user-scoped from birth, and the wipe list is "the follow-up". Nothing fails
 * — the route keeps deleting what it always deleted, the toast keeps saying
 * "all personal data has been deleted", and the new table quietly joins the
 * set of things that survive a confirmation the person typed by hand. That is
 * how a 13-table wipe ended up facing an 80-table schema.
 *
 * Both ends are literals — Prisma model blocks on one side, exported arrays
 * and objects on the other — so the matcher is exact. Nothing here greps for
 * intent.
 *
 * What it proves:
 *   1. every model carrying a `userId` column is either wiped or exempt with a
 *      reason;
 *   2. every model without one either reaches a wiped model through a chain of
 *      required `onDelete: Cascade` relations (so the database removes it) or
 *      is declared instance-scoped;
 *   3. every `User` column is either reset or kept with a reason;
 *   4. the delete order lists children before parents, so the per-model counts
 *      in the audit row are truthful;
 *   5. no exemption has gone stale.
 *
 * Its honest limit: it proves classification, not judgement. It cannot tell
 * that a model was put on the exempt list for a bad reason — only that
 * somebody had to write a reason down. And it reads relations, so a table
 * linked to an account by a bare `userId` string with no foreign key (there
 * are two: `TelegramScheduledDeletion`, `TelegramPromptContext`) is caught by
 * rule 1 only because the column name matches the convention.
 *
 * Mutation check: remove any entry from `WIPE_MODELS` and this goes red naming
 * that model; add a column to `model User` without classifying it and it goes
 * red naming the column.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  INSTANCE_SCOPED,
  USER_KEPT_FIELDS,
  USER_RESET,
  WIPE_EXEMPT,
  WIPE_MODELS,
  WIPE_OWNER_FIELDS,
  wipeDelegateKey,
  wipeWhere,
} from "@/lib/data-wipe/wipe-plan";

const SCHEMA = join(process.cwd(), "prisma", "schema.prisma");

interface Relation {
  /** Target model name. */
  target: string;
  cascade: boolean;
  /** `true` when the relation field is optional (`Model?`). */
  optional: boolean;
}

interface ModelShape {
  scalars: string[];
  relations: Relation[];
}

function parseSchema(schema: string): Map<string, ModelShape> {
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

const schemaText = readFileSync(SCHEMA, "utf8");
const models = parseSchema(schemaText);
const wipeSet = new Set<string>(WIPE_MODELS);

describe("data-wipe completeness", () => {
  it("parses the schema into a plausible shape", () => {
    expect(models.size).toBeGreaterThan(100);
    expect(models.get("Measurement")?.scalars).toContain("userId");
    expect(models.get("Measurement")?.scalars).not.toContain("user");
    expect(models.get("User")?.scalars).toContain("heightCm");
    expect(models.get("User")?.scalars).not.toContain("measurements");
    expect(
      models.get("CoachMessage")?.relations.map((r) => r.target),
    ).toContain("CoachConversation");
  });

  it("wipes effective-dated health profile fact revisions", () => {
    expect(WIPE_MODELS).toContain("HealthProfileFactRevision");
  });

  it("every model with a userId column is wiped or exempt with a reason", () => {
    const userScoped = [...models]
      .filter(([, shape]) => shape.scalars.includes("userId"))
      .map(([name]) => name);

    expect(userScoped.length).toBeGreaterThan(80);

    const unclassified = userScoped.filter(
      (name) =>
        !wipeSet.has(name) &&
        !(name in WIPE_EXEMPT) &&
        !(name in INSTANCE_SCOPED),
    );

    if (unclassified.length > 0) {
      throw new Error(
        `${unclassified.length} user-scoped model(s) are in neither the wipe list nor the exemption list:\n` +
          unclassified.map((n) => `  ❌ ${n}`).join("\n") +
          "\n\nA person who types the confirmation on Settings → Delete All Data " +
          "expects these rows gone. Add each to WIPE_MODELS, or to WIPE_EXEMPT " +
          "with the reason keeping it is not account deletion — and say so in " +
          "the confirmation copy.",
      );
    }

    const bothWays = userScoped.filter(
      (name) => wipeSet.has(name) && name in WIPE_EXEMPT,
    );
    expect(bothWays, "a model cannot be both wiped and exempt").toEqual([]);
  });

  it("every model without a userId column is reached by cascade or declared instance-scoped", () => {
    // Fixpoint over required cascade relations: a model is covered when the
    // database removes it as a consequence of a row the wipe deletes.
    const covered = new Set<string>(wipeSet);
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

    const orphans = [...models]
      .filter(([, shape]) => !shape.scalars.includes("userId"))
      .map(([name]) => name)
      .filter(
        (name) =>
          !covered.has(name) &&
          !(name in INSTANCE_SCOPED) &&
          !(name in WIPE_EXEMPT),
      );

    if (orphans.length > 0) {
      throw new Error(
        `${orphans.length} model(s) carry no userId, are not removed by any cascade from a wiped row, and are not declared instance-scoped:\n` +
          orphans.map((n) => `  ❌ ${n}`).join("\n") +
          "\n\nEither give the parent relation onDelete: Cascade, add the model " +
          "to WIPE_MODELS, or add it to INSTANCE_SCOPED with the reason it " +
          "belongs to the instance rather than to an account.",
      );
    }
  });

  it("every User column is either reset or kept with a reason", () => {
    const columns = models.get("User")?.scalars ?? [];
    expect(columns.length).toBeGreaterThan(80);

    const reset = new Set(Object.keys(USER_RESET));
    const kept = new Set(Object.keys(USER_KEPT_FIELDS));

    const unclassified = columns.filter((c) => !reset.has(c) && !kept.has(c));
    if (unclassified.length > 0) {
      throw new Error(
        `${unclassified.length} User column(s) are in neither USER_RESET nor USER_KEPT_FIELDS:\n` +
          unclassified.map((c) => `  ❌ ${c}`).join("\n") +
          "\n\nA column on the account row survives the wipe by default. Reset " +
          "it, or record why keeping it is not keeping the person's record.",
      );
    }

    const bothWays = columns.filter((c) => reset.has(c) && kept.has(c));
    expect(bothWays, "a column cannot be both reset and kept").toEqual([]);
  });

  it("carries no stale classification", () => {
    for (const name of WIPE_MODELS) {
      expect(
        models.has(name),
        `WIPE_MODELS names "${name}", which is not a model`,
      ).toBe(true);
    }
    for (const [name, reason] of Object.entries(WIPE_EXEMPT)) {
      expect(
        models.has(name),
        `WIPE_EXEMPT names "${name}", which is not a model`,
      ).toBe(true);
      expect(
        reason.length,
        `WIPE_EXEMPT.${name} needs a real reason`,
      ).toBeGreaterThan(30);
    }
    for (const [name, reason] of Object.entries(INSTANCE_SCOPED)) {
      expect(
        models.has(name),
        `INSTANCE_SCOPED names "${name}", which is not a model`,
      ).toBe(true);
      expect(
        reason.length,
        `INSTANCE_SCOPED.${name} needs a real reason`,
      ).toBeGreaterThan(20);
    }
    const columns = new Set(models.get("User")?.scalars ?? []);
    for (const [column, reason] of Object.entries(USER_KEPT_FIELDS)) {
      expect(
        columns.has(column),
        `USER_KEPT_FIELDS names "${column}", which is no longer a User column`,
      ).toBe(true);
      expect(
        reason.length,
        `USER_KEPT_FIELDS.${column} needs a real reason`,
      ).toBeGreaterThan(20);
    }
    expect(new Set(WIPE_MODELS).size, "WIPE_MODELS repeats a model").toBe(
      WIPE_MODELS.length,
    );
  });

  it("deletes children before their parents so the counts are truthful", () => {
    const position = new Map(WIPE_MODELS.map((m, i) => [m as string, i]));
    const violations: string[] = [];
    for (const child of WIPE_MODELS) {
      const shape = models.get(child);
      if (!shape) continue;
      for (const relation of shape.relations) {
        if (!relation.cascade) continue;
        if (relation.target === child) continue;
        if (!position.has(relation.target)) continue;
        if (position.get(child)! > position.get(relation.target)!) {
          violations.push(
            `${child} (#${position.get(child)}) cascades from ${relation.target} (#${position.get(relation.target)})`,
          );
        }
      }
    }
    expect(
      violations,
      `WIPE_MODELS deletes a parent before its child, so the child's count reports 0 for rows that existed:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("maps every wiped model to a plausible delegate key", () => {
    for (const model of WIPE_MODELS) {
      const key = wipeDelegateKey(model);
      expect(key[0]).toBe(model[0].toLowerCase());
      expect(key.slice(1)).toBe(model.slice(1));
    }
  });

  /**
   * The wipe loop asks every model the same question — "your rows for this
   * account" — and the convention that answers it is a `userId` column. A
   * model that relates two accounts has no such column, and before
   * `WIPE_OWNER_FIELDS` existed the only way to notice was a Prisma error at
   * request time, inside the wipe transaction, after the confirmation was
   * typed.
   */
  it("knows how every wiped model belongs to an account", () => {
    const unaddressable = WIPE_MODELS.filter((model) => {
      const shape = models.get(model);
      if (!shape) return false;
      return !shape.scalars.includes("userId") && !(model in WIPE_OWNER_FIELDS);
    });
    expect(
      unaddressable,
      `these wiped models carry no userId, so the wipe cannot select their rows:\n${unaddressable.join("\n")}\n\n` +
        "Add each to WIPE_OWNER_FIELDS naming the columns that bind a row to " +
        "an account.",
    ).toEqual([]);
  });

  it("names real columns in WIPE_OWNER_FIELDS, on wiped models only", () => {
    for (const [model, fields] of Object.entries(WIPE_OWNER_FIELDS)) {
      expect(
        (WIPE_MODELS as readonly string[]).includes(model),
        `WIPE_OWNER_FIELDS names "${model}", which the wipe does not delete`,
      ).toBe(true);
      const scalars = new Set(models.get(model)?.scalars ?? []);
      expect(
        fields.length,
        `${model} needs at least one owner column`,
      ).toBeGreaterThan(0);
      for (const field of fields) {
        expect(
          scalars.has(field),
          `WIPE_OWNER_FIELDS.${model} names "${field}", which is not a column on that model`,
        ).toBe(true);
      }
    }
  });

  it("selects both sides of an account grant", () => {
    // Spelled out rather than left to the generic check above: wiping only the
    // grantor side would delete the grants this account made and leave it
    // still holding read access to other people's records.
    expect(wipeWhere("AccountGrant", "u1")).toEqual({
      OR: [{ grantorId: "u1" }, { granteeId: "u1" }],
    });
    expect(wipeWhere("Measurement", "u1")).toEqual({ userId: "u1" });
  });

  it("selects both record and recipient ownership of a Guardian egress claim", () => {
    expect(wipeWhere("NotificationEgressAuthorization", "u1")).toEqual({
      OR: [{ recordUserId: "u1" }, { recipientUserId: "u1" }],
    });
  });
});
