/**
 * Read-only diagnostic for measurement rows stored in a NON-canonical unit.
 *
 * Canonical storage is SI: every write path stamps `getUnitForType(type)`. The
 * one historical leak was the MCP `log_measurement` tool, which persisted a
 * caller-supplied `unit` verbatim (closed in v1.32.26). A row whose `unit`
 * column differs from its type's canonical unit is such a legacy row, and it
 * mislabels every display surface that trusts the column.
 *
 * This groups measurements by `(type, unit)` and prints every group whose
 * `unit` is not the canonical unit for its type, flagging whether the stored
 * unit is a RECOGNISED alias (mechanically convertible by the companion
 * convert script) or UNKNOWN (needs a manual look). Nothing is written.
 *
 * NOT auto-fixable and deliberately out of scope: a row whose stored unit IS
 * already canonical but whose VALUE was a foreign unit (e.g. a lb reading typed
 * into the old kg-labelled entry form). Those are indistinguishable from real
 * canonical readings; the reporter edits them via the record list.
 *
 * Run (inside the app container, which has DATABASE_URL):
 *   pnpm dlx tsx scripts/diagnose-noncanonical-measurement-units.ts
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import { getUnitForType } from "@/lib/validations/measurement";
import { resolveToCanonicalUnit } from "@/lib/measurements/unit-aliases";

async function main(): Promise<void> {
  const groups = await prisma.measurement.groupBy({
    by: ["type", "unit"],
    _count: { _all: true },
  });

  const mismatches = groups.filter((g) => {
    if (g.unit === null) return false;
    return g.unit !== getUnitForType(g.type);
  });

  if (mismatches.length === 0) {
    console.log("No non-canonical measurement units found. Storage is clean.");
    return;
  }

  let convertible = 0;
  let unknown = 0;
  console.log(
    `Found ${mismatches.length} non-canonical (type, unit) group(s):\n`,
  );
  for (const g of mismatches.sort((a, b) => b._count._all - a._count._all)) {
    const canonical = getUnitForType(g.type);
    // Probe convertibility with a neutral value — only the recognition matters.
    const recognised = resolveToCanonicalUnit(g.type, 1, g.unit as string);
    const status = recognised ? "CONVERTIBLE" : "UNKNOWN — manual review";
    if (recognised) convertible += g._count._all;
    else unknown += g._count._all;
    console.log(
      `  ${g.type}: stored="${g.unit}" canonical="${canonical}" ` +
        `rows=${g._count._all} [${status}]`,
    );
  }
  console.log(
    `\nTotals: ${convertible} row(s) convertible, ${unknown} row(s) unknown.`,
  );
  console.log(
    "Convert the recognised aliases with:\n" +
      "  pnpm dlx tsx scripts/convert-noncanonical-measurement-units.ts --execute",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
