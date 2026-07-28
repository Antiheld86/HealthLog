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

/**
 * The second half of the guard: a `BACKED_UP` model either travels BOTH ways or
 * is named as debt.
 *
 * The first half above proves every model has an opinion. It would pass
 * unchanged while a model classified as carried was read into the payload and
 * never written back — which is not a hypothetical, it is what happened to the
 * nutrient day totals, to the custom mood tags, and to the custom cycle
 * symptoms, three releases running.
 *
 * The check reads the declared writer and restore files rather than grepping
 * for a route, BECAUSE the route delegates. A review that grepped only
 * `restore/route.ts` concluded the cycle data was never restored and had to be
 * retracted; `restoreCycleData` and `restoreProfileData` both live elsewhere.
 * Following the helpers is the entire difficulty of this question, so the file
 * list is declared next to the verdicts and checked to exist.
 */

import {
  BACKUP_RESTORE_FILES,
  BACKUP_WRITER_FILES,
  COVERAGE_PENDING,
  TWO_ENDED_MODELS,
} from "@/lib/export/backup-plan";

const REPO_ROOT = resolve(__dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

/** `Measurement` → `measurement`, the Prisma delegate name. */
function delegateName(model: string): string {
  return model[0].toLowerCase() + model.slice(1);
}

/**
 * Relation fields on OTHER models whose type is `model`.
 *
 * A child rides its parent — `include: { schedules: true }` on the way out,
 * `schedules: { create: [...] }` on the way back — so a delegate-only search
 * would report every nested child as uncarried and the guard would be noise.
 */
function relationFieldNames(model: string): string[] {
  const source = readFileSync(SCHEMA_PATH, "utf8");
  const names = new Set<string>();
  for (const [, body] of source.matchAll(/^model\s+\w+\s*\{([\s\S]*?)^\}/gm)) {
    for (const line of body.split("\n")) {
      const match = /^\s*(\w+)\s+(\w+)(\[\])?\??\s*(@|$)/.exec(line);
      if (match && match[2] === model) names.add(match[1]);
    }
  }
  return [...names];
}

const READ_OPS = /(findMany|findUnique|findFirst|findUniqueOrThrow|groupBy)/;
const WRITE_OPS = /(create|createMany|upsert|update|updateMany)/;
const READ_RELATION_OPS = /[{[t]/;
const WRITE_RELATION_OPS = /\{\s*create\b/;

/** Does any of `files` touch `model` through matching delegate and relation operations? */
function touches(
  files: readonly string[],
  model: string,
  delegateOps: RegExp,
  relationOps: RegExp,
): boolean {
  const delegate = delegateName(model);
  const relations = relationFieldNames(model);
  return files.some((file) => {
    // Whitespace-flattened so a call broken across lines still matches.
    const source = read(file).replace(/\s+/g, " ");
    for (const match of source.matchAll(
      new RegExp(`\\.${delegate}\\s*\\.\\s*(\\w+)`, "g"),
    )) {
      if (delegateOps.test(match[1])) return true;
    }
    return relations.some((relation) =>
      new RegExp(`\\b${relation}\\s*:\\s*(?:${relationOps.source})`).test(
        source,
      ),
    );
  });
}

describe("every backed-up model travels both ways, or is named as debt", () => {
  it("does not count a nested relation read as a restore write", () => {
    expect(
      touches(
        ["src/app/api/admin/backups/[id]/restore/route.ts"],
        "User",
        WRITE_OPS,
        WRITE_RELATION_OPS,
      ),
    ).toBe(false);
  });

  it("declares writer and restore files that exist", () => {
    for (const file of [...BACKUP_WRITER_FILES, ...BACKUP_RESTORE_FILES]) {
      expect(() => read(file), `${file} is declared but missing`).not.toThrow();
    }
    // A grep of the restore ROUTE alone is the mistake this list prevents, so
    // the list has to name more than the route.
    expect(BACKUP_RESTORE_FILES.length).toBeGreaterThan(1);
  });

  it("splits BACKED_UP into exactly two-ended and pending, with no overlap", () => {
    const backedUp = new Set<string>(BACKED_UP_MODELS);
    const twoEnded = new Set(TWO_ENDED_MODELS);
    const pending = new Set(Object.keys(COVERAGE_PENDING));

    const both = [...twoEnded].filter((m) => pending.has(m));
    expect(
      both,
      "a model cannot be both proven and pending — that is how a gap hides",
    ).toEqual([]);

    const unaccounted = [...backedUp].filter(
      (m) => !twoEnded.has(m) && !pending.has(m),
    );
    expect(
      unaccounted,
      "add each to TWO_ENDED_MODELS once its reader AND restore branch land, " +
        "or to COVERAGE_PENDING with what an account loses meanwhile",
    ).toEqual([]);

    const foreign = [...twoEnded, ...pending].filter((m) => !backedUp.has(m));
    expect(
      foreign,
      "only a BACKED_UP model has two ends to have; these are not on that list",
    ).toEqual([]);
  });

  it("finds a payload reader for every model claimed two-ended", () => {
    const missing = TWO_ENDED_MODELS.filter(
      (model) =>
        !touches(BACKUP_WRITER_FILES, model, READ_OPS, READ_RELATION_OPS),
    );
    expect(
      missing,
      "claimed carried, but no backup writer reads it — the restore branch has " +
        "nothing feeding it and a restore silently rebuilds the account without it",
    ).toEqual([]);
  });

  it("finds a restore branch for every model claimed two-ended", () => {
    const missing = TWO_ENDED_MODELS.filter(
      (model) =>
        !touches(BACKUP_RESTORE_FILES, model, WRITE_OPS, WRITE_RELATION_OPS),
    );
    expect(
      missing,
      "claimed carried, but nothing writes it back — the export is a file the " +
        "restore reads past, which is the worst of both: the data is in the " +
        "backup and not in the account",
    ).toEqual([]);
  });

  it("gives every pending model a reason that says what is lost", () => {
    const thin = Object.entries(COVERAGE_PENDING)
      .filter(([, reason]) => reason.trim().length < 60)
      .map(([model]) => model);
    expect(
      thin,
      "'not yet' is not a reason — say what an account loses, so the debt can " +
        "be ordered by cost to a person rather than by ease of writing",
    ).toEqual([]);
  });

  it("proves the structured-profile models are on the covered side", () => {
    // These account-owned rows are exported and restored explicitly rather
    // than being treated as reconstructible data.
    for (const model of [
      "UserHealthProfile",
      "HealthProfileFactRevision",
      "CustomMetric",
      "CustomMetricEntry",
    ]) {
      expect(BACKED_UP_MODELS).toContain(model);
      expect(TWO_ENDED_MODELS).toContain(model);
      expect(COVERAGE_PENDING).not.toHaveProperty(model);
    }
  });
});
