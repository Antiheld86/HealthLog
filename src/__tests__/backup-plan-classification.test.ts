import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUTH_MODELS_OUT_OF_SCOPE,
  BACKED_UP_MODELS,
  DERIVED_MODELS,
  NOT_IN_BACKUP_MODELS,
  backupVerdict,
} from "@/lib/export/backup-plan";

/**
 * Every model in the schema has a written verdict about the backup.
 *
 * This is the first half of the backup guard: classification. The second half
 * — that every `BACKED_UP` model actually has a payload reader AND a restore
 * branch — DOES NOT EXIST YET. It is the harder half and the one that matters,
 * because a model classified as carried and then never restored is the defect
 * rather than the fix, and this test would pass either way.
 *
 * Until it lands, `BACKED_UP` means "must be carried", not "is carried".
 *
 * The failure this prevents: a model is added to `schema.prisma`, it is
 * user-scoped from birth, and it is outside the backup by default. Nothing
 * notices, and the gap is only discovered by someone restoring a backup and
 * finding a part of their record missing — which is the worst possible moment
 * and the worst possible messenger.
 */

const SCHEMA_PATH = resolve(__dirname, "../../prisma/schema.prisma");

/** Models declared in the schema, minus `User` itself (the account row). */
function schemaModels(): string[] {
  const source = readFileSync(SCHEMA_PATH, "utf8");
  return [...source.matchAll(/^model\s+(\w+)\s*\{/gm)]
    .map((m) => m[1])
    .filter((name) => name !== "User");
}

/**
 * Models with no `userId` and no user relation are instance-scoped (queue
 * tables, rate-limit buckets, invite codes the operator issues). They are not
 * an account's data and the wipe plan already declares them as such.
 */
function isUserScoped(model: string): boolean {
  const source = readFileSync(SCHEMA_PATH, "utf8");
  const block = new RegExp(
    `^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`,
    "m",
  ).exec(source);
  if (!block) return false;
  const body = block[1];
  return /\buserId\b/.test(body) || /\buser\s+User\b/.test(body);
}

describe("every schema model has a backup verdict", () => {
  const models = schemaModels();

  it("reads a schema with models in it (no vacuous pass)", () => {
    expect(models.length).toBeGreaterThan(50);
  });

  it("classifies every user-scoped model", () => {
    const unclassified = models
      .filter(isUserScoped)
      .filter((m) => backupVerdict(m) === null);

    if (unclassified.length > 0) {
      throw new Error(
        `${unclassified.length} user-scoped model(s) have no backup verdict:\n\n` +
          unclassified.map((m) => `  ❌ ${m}`).join("\n") +
          "\n\nAdd each to src/lib/export/backup-plan.ts: to BACKED_UP_MODELS if an " +
          "account would lose something real without it, to DERIVED_MODELS with what " +
          "rebuilds it, or to NOT_IN_BACKUP_MODELS with why it must not travel. " +
          "A new model is user-scoped from birth and outside the backup by default, " +
          "which is exactly the silence this test exists to break.",
      );
    }
  });

  it("carries no verdict for a model the schema no longer has", () => {
    const known = new Set(models);
    const stale = [
      ...BACKED_UP_MODELS,
      ...Object.keys(DERIVED_MODELS),
      ...Object.keys(NOT_IN_BACKUP_MODELS),
      ...AUTH_MODELS_OUT_OF_SCOPE,
    ].filter((m) => !known.has(m));

    expect(
      stale,
      `verdicts for models that no longer exist: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("gives each model exactly one verdict", () => {
    const seen = new Map<string, string[]>();
    const add = (model: string, list: string) => {
      seen.set(model, [...(seen.get(model) ?? []), list]);
    };
    for (const m of BACKED_UP_MODELS) add(m, "BACKED_UP");
    for (const m of Object.keys(DERIVED_MODELS)) add(m, "DERIVED");
    for (const m of Object.keys(NOT_IN_BACKUP_MODELS)) add(m, "NOT_IN_BACKUP");
    for (const m of AUTH_MODELS_OUT_OF_SCOPE) add(m, "AUTH");

    const doubled = [...seen.entries()].filter(([, lists]) => lists.length > 1);
    expect(
      doubled.map(([m, lists]) => `${m}: ${lists.join(" + ")}`),
      "a model classified twice means two readers can each believe the other handles it",
    ).toEqual([]);
  });

  it("gives every excluded model a reason, not an empty string", () => {
    const empty = [
      ...Object.entries(DERIVED_MODELS),
      ...Object.entries(NOT_IN_BACKUP_MODELS),
    ]
      // 20 characters let "Same as WithingsConnection." through, which is a
      // pointer rather than a reason: if the entry it points at changes, this
      // one silently inherits something else. 60 forces the decision to be
      // written where it is made.
      .filter(([, reason]) => reason.trim().length < 60)
      .map(([model]) => model);
    expect(
      empty,
      "a one-word reason is how a decision stops being reviewable",
    ).toEqual([]);
  });
});
