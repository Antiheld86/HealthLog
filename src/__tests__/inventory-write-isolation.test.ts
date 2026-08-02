/**
 * v1.16.10 — inventory write-path isolation guard.
 *
 * The consumption stamp on `MedicationIntakeEvent.inventoryConsumption`
 * is only an exactly-once ledger as long as EVERY stock movement flows
 * through `src/lib/medications/inventory/consumption.ts` (intake-driven
 * consume / restore) or the dedicated inventory surfaces (the CRUD
 * routes, the create-input builder, and the expire cron in
 * `service.ts`). A `medicationInventoryItem` write sprinkled into some
 * future intake path would bypass the stamp and re-open the
 * double-decrement / stranded-stock class of bugs this release closed.
 *
 * This test walks every TypeScript / TSX file under `src/` (excluding
 * tests + generated code) and asserts that no file outside the
 * allowlist invokes a Prisma write method on `medicationInventoryItem`.
 * Reads (`findFirst`, `findMany`, …) stay legal everywhere.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "../..");
const SRC = join(ROOT, "src");

/**
 * Pruned on purpose: the generated Prisma client, build output, vendored
 * dependencies, and the suites themselves are not the tree under audit. Note
 * what is NOT pruned — this walk descends into dot-prefixed directories, so
 * `src/app/.well-known` is inside the sweep. `fs.globSync` would drop it.
 */
const SKIP_DIRS = new Set(["__tests__", "node_modules", ".next", "generated"]);

/**
 * Files allowed to write `medicationInventoryItem` rows:
 *   - the consumption module (intake-driven consume / restore);
 *   - the inventory persistence helpers (expire cron `updateMany`);
 *   - the two inventory CRUD routes (register / mutate / delete);
 *   - the v1.25 note-encryption backfill, whose update only rewrites the
 *     `notes` / `notesEncrypted` columns (never units / state) and so cannot
 *     touch the consumption stamp this guard protects.
 */
const ALLOWED_WRITERS = new Set(
  [
    "src/lib/medications/inventory/consumption.ts",
    "src/lib/medications/inventory/service.ts",
    "src/app/api/medications/[id]/inventory/route.ts",
    "src/app/api/medications/[id]/inventory/[itemId]/route.ts",
    "src/lib/jobs/med-notes-encryption-backfill.ts",
  ].map((p) => p.split("/").join(sep)),
);

const WRITE_PATTERN =
  /medicationInventoryItem\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const stat = statSync(p);
    if (stat.isDirectory()) {
      walk(p, out);
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

describe("medicationInventoryItem write isolation", () => {
  // A sweep that finds nothing agrees with every allowlist, so the size of
  // the tree being read is asserted before anything is concluded from it.
  // Pinned below the real source-file count with headroom, not at one.
  it("reads the tree it claims to sweep", () => {
    expect(walk(SRC).length).toBeGreaterThan(1500);
  });

  it("no file outside the consumption module + inventory surfaces writes inventory items", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(ROOT, file);
      if (ALLOWED_WRITERS.has(rel)) continue;
      const content = readFileSync(file, "utf8");
      if (WRITE_PATTERN.test(content)) {
        offenders.push(rel);
        WRITE_PATTERN.lastIndex = 0;
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the allowlisted writers actually exist (allowlist stays honest)", () => {
    for (const rel of ALLOWED_WRITERS) {
      expect(() => statSync(join(ROOT, rel))).not.toThrow();
    }
  });
});
