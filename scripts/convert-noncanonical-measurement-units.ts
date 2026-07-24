/**
 * Convert measurement rows stored in a RECOGNISED non-canonical unit to
 * canonical SI, in place. Companion to
 * `diagnose-noncanonical-measurement-units.ts` — run the diagnose first.
 *
 * SAFETY:
 *   - Dry-run by default. Writes ONLY when called with `--execute`.
 *   - Touches ONLY rows whose stored `unit` differs from the type's canonical
 *     unit AND resolves through the shared alias resolver (lb/lbs/pound(s),
 *     in/inch(es), °F, mmol/L). A row whose unit is already canonical, or whose
 *     unit is unrecognised, is never touched.
 *   - Each row is rewritten to the canonical `{ value, unit }` the same
 *     resolver the CSV importer + MCP write path use produces, so the number is
 *     re-expressed, never re-labelled in place (which would corrupt it).
 *   - Affected users' measurement caches are busted at the end.
 *
 * This repairs the storage LABEL + value for the recognised-alias legacy rows
 * (the MCP-leak class). It cannot repair a row whose unit was already canonical
 * but whose value was a foreign unit — that class is not mechanically
 * identifiable (see the diagnose script).
 *
 * Run (inside the app container):
 *   pnpm dlx tsx scripts/convert-noncanonical-measurement-units.ts            # dry-run
 *   pnpm dlx tsx scripts/convert-noncanonical-measurement-units.ts --execute  # write
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import { getUnitForType } from "@/lib/validations/measurement";
import { resolveToCanonicalUnit } from "@/lib/measurements/unit-aliases";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");

  const groups = await prisma.measurement.groupBy({
    by: ["type", "unit"],
    _count: { _all: true },
  });
  const convertibleGroups = groups.filter((g) => {
    if (g.unit === null || g.unit === getUnitForType(g.type)) return false;
    return resolveToCanonicalUnit(g.type, 1, g.unit) !== null;
  });

  if (convertibleGroups.length === 0) {
    console.log(
      "Nothing to convert — no recognised non-canonical units found.",
    );
    return;
  }

  const affectedUsers = new Set<string>();
  let converted = 0;

  for (const g of convertibleGroups) {
    const canonical = getUnitForType(g.type);
    const rows = await prisma.measurement.findMany({
      where: { type: g.type, unit: g.unit },
      select: { id: true, userId: true, value: true, unit: true },
    });
    for (const row of rows) {
      const resolved = resolveToCanonicalUnit(
        g.type,
        row.value,
        row.unit as string,
      );
      if (!resolved) continue; // defensive; group already filtered
      converted += 1;
      affectedUsers.add(row.userId);
      console.log(
        `  ${execute ? "convert" : "would convert"} ${g.type} ${row.id}: ` +
          `${row.value} ${row.unit} -> ${resolved.value} ${resolved.unit}`,
      );
      if (execute) {
        await prisma.measurement.update({
          where: { id: row.id },
          data: { value: resolved.value, unit: canonical },
        });
      }
    }
  }

  if (execute) {
    for (const userId of affectedUsers) {
      invalidateUserMeasurements(userId, { evict: true });
    }
    console.log(
      `\nConverted ${converted} row(s) across ${affectedUsers.size} user(s). ` +
        "Rollups recompute on the next read/backfill.",
    );
  } else {
    console.log(
      `\nDry run: ${converted} row(s) across ${affectedUsers.size} user(s) ` +
        "would be converted. Re-run with --execute to write.",
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
