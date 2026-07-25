/**
 * Structural guard on the external-id stability floor.
 *
 * A client-supplied `externalId` is half of every ingest dedup key. An id
 * that rotates between client launches never matches its own earlier row,
 * so each sync sweep mints a fresh record — the failure mode that filled a
 * live instance with phantom medications, one per sweep, none of which
 * could ever collect a dose.
 *
 * The fix is only durable if it cannot be bypassed by the NEXT route.
 * These guards freeze the two legal ways to accept the field:
 *
 *   1. the request schema routes it through `assertStableExternalId`, so
 *      the refusal rides the standard 422 multi-issue envelope; or
 *   2. the field is deliberately permissive because a schema-level refusal
 *      would fail a whole batch on one bad row — in which case the
 *      declaration carries an `@external-id-checked-per-entry: <path>`
 *      marker naming the file that runs `classifyExternalId` per entry,
 *      and this guard verifies that file really does.
 *
 * They are tripwires, not proofs. A reviewer who waves through a bad
 * addition defeats them, and no test substitutes for that review.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { globSync } from "node:fs";

const SRC = join(process.cwd(), "src");
const VALIDATOR_MODULE = "@/lib/validations/external-id";

function sourceFiles(): string[] {
  return globSync("**/*.{ts,tsx}", { cwd: SRC })
    .filter(
      (p) => !p.startsWith(`generated${sep}`) && !p.startsWith("generated/"),
    )
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .map((p) => p.split(sep).join("/"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/**
 * The file with its `import … from "…";` statements removed.
 *
 * A guard that greps the raw source cannot tell "this file APPLIES the
 * check" from "this file merely imports it" — deleting the call while
 * leaving the import would slip straight through. Every usage assertion
 * below therefore runs against the body, and the module import is
 * asserted separately where it matters.
 */
function body(rel: string): string {
  return read(rel).replace(/import\s+[\s\S]*?from\s+"[^"]+";/g, "");
}

/**
 * A REQUEST-side declaration of a client-supplied external identifier:
 * `externalId: z.…` / `externalSourceId: z.…` in a Zod object shape.
 *
 * Response DTOs under `lib/openapi/` are excluded below — those echo an
 * id the server already stored and validating them would be validating
 * our own output.
 */
const DECLARATION = /^\s*(externalId|externalSourceId)\s*:\s*z\b/gm;

/** `// @external-id-checked-per-entry: <path under repo root>` */
const MARKER = /@external-id-checked-per-entry:\s*(\S+)/;

/**
 * Files that declare the field but are deliberately outside the floor.
 * Each entry states WHY; an addition here is a decision, not a shortcut.
 */
const EXEMPT: Record<string, string> = {
  // Backup restore reads a payload the SERVER itself wrote and encrypted.
  // It has to reproduce the stored rows byte-for-byte — including ids that
  // predate this floor — or a self-hoster with an already-poisoned export
  // could never restore it. Nothing client-authored reaches this schema.
  "lib/validations/backup.ts":
    "restore payload is a server-written backup; refusing a stored id would block a restore",
};

/** Lines of `rel` (1-based) on which a request-side declaration appears. */
function declarationLines(rel: string): number[] {
  const source = read(rel);
  const lines: number[] = [];
  DECLARATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECLARATION.exec(source)) !== null) {
    lines.push(source.slice(0, m.index).split("\n").length);
  }
  return lines;
}

function declaringFiles(): string[] {
  return sourceFiles()
    .filter((rel) => !rel.startsWith("lib/openapi/"))
    .filter((rel) => declarationLines(rel).length > 0);
}

describe("every client-supplied external id routes through the stability floor", () => {
  it("finds the declaring files at all (the matcher still matches)", () => {
    // A guard whose matcher silently stops matching passes forever. Pin the
    // known set so a rename of the field or of the Zod idiom trips here.
    const files = declaringFiles();
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files).toContain("app/api/measurements/batch/route.ts");
    expect(files).toContain("lib/validations/medication/create-update.ts");
  });

  it.each(declaringFiles())(
    "%s either applies the field check or names the per-entry checker",
    (rel) => {
      if (rel in EXEMPT) {
        expect(EXEMPT[rel].length).toBeGreaterThan(20);
        return;
      }

      const usesFieldCheck =
        read(rel).includes(VALIDATOR_MODULE) &&
        body(rel).includes("assertStableExternalId");
      const marksPerEntry = MARKER.test(read(rel));
      expect(
        usesFieldCheck || marksPerEntry,
        `${rel} declares a client-supplied external id but neither applies ` +
          "`assertStableExternalId` to its request schema nor marks the declaration " +
          "`@external-id-checked-per-entry: <path>` naming the route that checks it per entry.",
      ).toBe(true);
    },
  );

  it.each(declaringFiles())(
    "%s — every per-entry marker points at a file that really checks per entry",
    (rel) => {
      if (rel in EXEMPT) return;
      const source = read(rel);
      MARKER.lastIndex = 0;
      const targets = [...source.matchAll(new RegExp(MARKER, "g"))].map(
        (m) => m[1],
      );
      for (const target of targets) {
        expect(
          target.startsWith("src/"),
          `${rel}: marker target "${target}" must be a repo-root-relative src/ path`,
        ).toBe(true);
        const checker = body(target.replace(/^src\//, ""));
        expect(
          checker.includes("classifyExternalId"),
          `${rel} points its per-entry marker at ${target}, but that file never calls classifyExternalId.`,
        ).toBe(true);
      }
    },
  );
});

describe("the batch surfaces refuse per entry, never whole-batch", () => {
  // Each of these drains a client sync queue. A schema-level refusal here
  // would stop a whole batch of good rows because of one bad one, which is
  // worse than the duplicate it prevents.
  const BATCH_ROUTES = [
    "app/api/measurements/batch/route.ts",
    "app/api/mood-entries/bulk/route.ts",
    "app/api/medications/intake/bulk/route.ts",
    "app/api/workouts/batch/route.ts",
    "app/api/cycle/day-logs/bulk/route.ts",
    "app/api/import/route.ts",
  ];

  it.each(BATCH_ROUTES)("%s classifies each entry itself", (rel) => {
    const source = body(rel);
    expect(source).toContain("classifyExternalId");
    expect(source).toContain("unstableExternalIdMeta");
  });

  it.each(BATCH_ROUTES.filter((r) => r !== "app/api/import/route.ts"))(
    "%s reports the shared per-entry reason code",
    (rel) => {
      // The JSON importer has no per-entry status envelope — it reports a
      // skipped COUNT — so it is the one batch surface without the code.
      expect(body(rel)).toContain("UNSTABLE_EXTERNAL_ID_REASON");
    },
  );
});
