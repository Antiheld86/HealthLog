/**
 * Structural guard binding `prisma/schema.prisma` to the ADMIN wipe.
 *
 * The per-account wipe grew a derived plan and a completeness test after it
 * was found deleting thirteen tables out of eighty-odd. The admin wipe — the
 * one an operator runs before handing a box on, "Deletes all data for all
 * users" — kept its inline list of nine `deleteMany` calls, written when nine
 * was most of the schema. It was still nine against a hundred and twenty-two
 * models: laboratory results, documents, cycle logs, journals, mood, workouts,
 * sleep and Coach conversations all survived a confirmation the operator typed
 * by hand. Nothing failed, because nothing was asking.
 *
 * So the route reads `ADMIN_WIPE_MODELS` — `WIPE_MODELS` minus the entries in
 * `ADMIN_WIPE_EXEMPT` — and this file asks the question its sibling asks for
 * the account wipe.
 *
 * What it proves:
 *   1. every model carrying a `userId` column is deleted by the admin wipe or
 *      excused by a named list with a written reason;
 *   2. every model without one either reaches an admin-wiped model through a
 *      chain of required `onDelete: Cascade` relations or is declared
 *      instance-scoped;
 *   3. every admin-only exemption names a real model that the per-account wipe
 *      DOES delete, so the entry is a deliberate subtraction rather than a
 *      stale name nobody re-read;
 *   4. the route carries no table list of its own — it iterates the plan.
 *
 * Its honest limit is the same as its sibling's: it proves classification, not
 * judgement. It cannot tell that a model was excused for a bad reason, only
 * that somebody had to write the reason down. And rule 4 is source-shaped: it
 * reads the route file for `deleteMany` calls on a literal delegate, so a
 * future inline list built some other way would slip it.
 *
 * Mutation check: remove any entry from `WIPE_MODELS` and this goes red naming
 * that model as unclassified; put an inline `tx.measurement.deleteMany({})`
 * back into the route and rule 4 goes red naming it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  parseWipeSchema,
  reachedByCascade,
} from "@/__tests__/helpers/wipe-schema-shape";
import {
  ADMIN_WIPE_EXEMPT,
  ADMIN_WIPE_MODELS,
  INSTANCE_SCOPED,
  WIPE_EXEMPT,
  WIPE_MODELS,
} from "@/lib/data-wipe/wipe-plan";

const ROUTE = join(
  process.cwd(),
  "src",
  "app",
  "api",
  "admin",
  "data",
  "route.ts",
);

const models = parseWipeSchema();
const adminWipeSet = new Set<string>(ADMIN_WIPE_MODELS);

/** Every list that is allowed to answer "why did this model survive?". */
function survivorReason(model: string): string | null {
  return (
    ADMIN_WIPE_EXEMPT[model] ??
    WIPE_EXEMPT[model] ??
    INSTANCE_SCOPED[model] ??
    null
  );
}

describe("admin data-wipe completeness", () => {
  it("deletes essentially the whole user-scoped schema", () => {
    // A floor, not a target. The defect this file exists for was a wipe that
    // covered nine tables while reporting success; a silent shrink back
    // towards that number fails here even if every survivor is classified.
    expect(ADMIN_WIPE_MODELS.length).toBeGreaterThan(80);
  });

  it("every model with a userId column is wiped or excused with a reason", () => {
    const userScoped = [...models]
      .filter(([, shape]) => shape.scalars.includes("userId"))
      .map(([name]) => name);

    expect(userScoped.length).toBeGreaterThan(80);

    const unclassified = userScoped.filter(
      (name) => !adminWipeSet.has(name) && survivorReason(name) === null,
    );

    if (unclassified.length > 0) {
      throw new Error(
        `${unclassified.length} user-scoped model(s) survive the admin wipe with nothing saying why:\n` +
          unclassified.map((n) => `  ❌ ${n}`).join("\n") +
          "\n\nAn operator who types DELETE ALL before handing this server on " +
          "expects these rows gone. Add each to WIPE_MODELS, or to " +
          "ADMIN_WIPE_EXEMPT / WIPE_EXEMPT / INSTANCE_SCOPED with the reason " +
          "keeping it is not keeping somebody's record.",
      );
    }
  });

  it("every model without a userId column is reached by cascade or declared instance-scoped", () => {
    const covered = reachedByCascade(models, adminWipeSet);

    const orphans = [...models]
      .filter(([, shape]) => !shape.scalars.includes("userId"))
      .map(([name]) => name)
      .filter((name) => !covered.has(name) && survivorReason(name) === null);

    if (orphans.length > 0) {
      throw new Error(
        `${orphans.length} model(s) carry no userId, are not removed by any cascade from an admin-wiped row, and are not declared instance-scoped:\n` +
          orphans.map((n) => `  ❌ ${n}`).join("\n"),
      );
    }
  });

  it("excuses only models the per-account wipe does delete, each with a reason", () => {
    for (const [name, reason] of Object.entries(ADMIN_WIPE_EXEMPT)) {
      expect(
        models.has(name),
        `ADMIN_WIPE_EXEMPT names "${name}", which is not a model`,
      ).toBe(true);
      // The list exists to record where the two wipes DIFFER. A name the
      // account wipe does not delete either is not a difference; it is a
      // stale entry hiding behind a plausible reason.
      expect(
        (WIPE_MODELS as readonly string[]).includes(name),
        `ADMIN_WIPE_EXEMPT names "${name}", which the per-account wipe does not delete either — the entry records no difference`,
      ).toBe(true);
      expect(
        reason.length,
        `ADMIN_WIPE_EXEMPT.${name} needs a real reason`,
      ).toBeGreaterThan(30);
    }
  });

  it("derives the model set instead of listing tables in the route", () => {
    const source = readFileSync(ROUTE, "utf8");

    expect(
      source.includes("ADMIN_WIPE_MODELS"),
      "the admin wipe route no longer reads the shared plan",
    ).toBe(true);

    // `tx.measurement.deleteMany(` and friends — the shape the inline list
    // had. The loop calls `resolveGlobalWipeDelegate(tx, model).deleteMany`,
    // which names no table and does not match.
    const inline = [
      ...source.matchAll(
        /\b(?:tx|prisma)\s*\.\s*(\w+)\s*\.\s*deleteMany\s*\(/g,
      ),
    ].map((m) => m[1]);

    expect(
      inline,
      `the admin wipe names tables inline again:\n${inline.join("\n")}\n\n` +
        "That list is how it drifted to nine tables: it was correct the day " +
        "it was written and nothing noticed when the schema moved past it. " +
        "Delete through ADMIN_WIPE_MODELS.",
    ).toEqual([]);
  });
});
