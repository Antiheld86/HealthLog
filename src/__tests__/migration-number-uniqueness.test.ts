/**
 * Structural guard — every Prisma migration owns a unique numeric prefix.
 *
 * Migrations are named `NNNN_description`, and the four-digit prefix is the
 * ordering key. When two short-lived branches each grab the next free number
 * and both merge, the tree ends up with two `0268_*` directories. Prisma
 * applies them in lexical order, but the collision is a silent
 * merge-time hazard: a reviewer reading `git log` sees one number twice, and a
 * later renumber has to touch history. This test fails the build the moment a
 * prefix repeats, so the collision is caught at PR CI rather than after merge.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../prisma/migrations",
);

const NUMBERED_MIGRATION = /^(\d+)_/;

/**
 * One grandfathered collision that predates this guard. `0025_refresh_tokens`
 * and `0025_user_locale_drift_fix` are both long applied on every deployed
 * database — a migration directory name is the primary key in the
 * `_prisma_migrations` ledger, so renaming either would orphan the applied
 * record and force a re-run on every tenant. It is frozen as history; the
 * guard grandfathers exactly this prefix and refuses every NEW one.
 */
const GRANDFATHERED_PREFIXES = new Set(["0025"]);

describe("prisma migrations — numeric prefixes are unique", () => {
  it("has no two migration directories sharing a numeric prefix", () => {
    const prefixes = new Map<string, string[]>();
    for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = NUMBERED_MIGRATION.exec(entry.name);
      if (!match) continue;
      const prefix = match[1];
      const bucket = prefixes.get(prefix) ?? [];
      bucket.push(entry.name);
      prefixes.set(prefix, bucket);
    }

    const collisions = [...prefixes.entries()].filter(
      ([prefix, names]) =>
        names.length > 1 && !GRANDFATHERED_PREFIXES.has(prefix),
    );

    expect(
      collisions,
      collisions.length > 0
        ? `Duplicate migration prefixes:\n${collisions
            .map(([prefix, names]) => `  ${prefix}: ${names.join(", ")}`)
            .join("\n")}`
        : undefined,
    ).toEqual([]);
  });

  it("finds the migration set (guards against a broken directory path)", () => {
    const numbered = readdirSync(MIGRATIONS_DIR, {
      withFileTypes: true,
    }).filter((e) => e.isDirectory() && NUMBERED_MIGRATION.test(e.name));
    // Not `> 0`: a walk that returns a single directory is as broken as one
    // that returns none, and both would pass a zero floor. Pinned below the
    // real migration count with headroom.
    expect(numbered.length).toBeGreaterThan(200);
  });
});
