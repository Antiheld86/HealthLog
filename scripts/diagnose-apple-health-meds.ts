/**
 * Read-only diagnostic for the phantom Apple-Health medication mirror.
 *
 * Prints the shape of every medication matching a name (default
 * "Blutdruckmittel"): its provenance (externalSource / externalId), dose,
 * asNeeded flag, createdAt, and its intake-event + schedule counts. Nothing is
 * written. Use it to confirm the root cause before running any cleanup:
 *
 *   - externalSource = APPLE_HEALTH with many DISTINCT externalId values
 *     (address-shaped or otherwise mutually different) => the iOS mirror is
 *     minting a fresh key per sync, so idempotency never matches.
 *   - externalSource NULL => the rows are not mirror rows (a different path).
 *   - createdAt spread => one row per sync sweep vs a single burst.
 *
 * Run (inside the app container, which has DATABASE_URL):
 *   pnpm dlx tsx scripts/diagnose-apple-health-meds.ts
 *   pnpm dlx tsx scripts/diagnose-apple-health-meds.ts --name "Blutdruckmittel"
 */
import "dotenv/config";

import { prisma } from "@/lib/db";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const name = argValue("--name") ?? "Blutdruckmittel";

  const meds = await prisma.medication.findMany({
    where: { name },
    select: {
      id: true,
      userId: true,
      name: true,
      dose: true,
      asNeeded: true,
      externalSource: true,
      externalId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (meds.length === 0) {
    console.log(`No medications found with name "${name}".`);
    return;
  }

  const rows = [];
  for (const m of meds) {
    const [intakes, schedules] = await Promise.all([
      prisma.medicationIntakeEvent.count({
        where: { medicationId: m.id, deletedAt: null },
      }),
      prisma.medicationSchedule.count({ where: { medicationId: m.id } }),
    ]);
    rows.push({
      id: m.id,
      user: m.userId.slice(0, 8),
      source: m.externalSource ?? "NULL",
      externalId: m.externalId ?? "NULL",
      dose: m.dose,
      asNeeded: m.asNeeded,
      intakes,
      schedules,
      createdAt: m.createdAt.toISOString(),
    });
  }

  console.log(`\n=== ${rows.length} medication(s) named "${name}" ===\n`);
  console.table(rows);

  const distinctExternalIds = new Set(
    meds.map((m) => m.externalId).filter((v): v is string => v !== null),
  );
  const bySource = new Map<string, number>();
  for (const m of meds) {
    const key = m.externalSource ?? "NULL";
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }
  const created = meds.map((m) => m.createdAt.getTime());
  const withIntake = rows.filter((r) => r.intakes > 0).length;
  const withSchedule = rows.filter((r) => r.schedules > 0).length;

  console.log("\n=== summary ===");
  console.log(`total rows:              ${rows.length}`);
  console.log(
    `externalSource breakdown: ${[...bySource.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
  console.log(`distinct externalId:     ${distinctExternalIds.size}`);
  console.log(`rows with >=1 intake:    ${withIntake}`);
  console.log(`rows with >=1 schedule:  ${withSchedule}`);
  console.log(
    `createdAt range:         ${new Date(Math.min(...created)).toISOString()} .. ${new Date(Math.max(...created)).toISOString()}`,
  );
  console.log(
    "\nSample externalId values (first 5):\n" +
      meds
        .slice(0, 5)
        .map((m) => `  ${m.externalId ?? "NULL"}`)
        .join("\n"),
  );
  console.log(
    "\nRead-only. No rows were modified. If the shape confirms the phantom set,\n" +
      "run scripts/cleanup-apple-health-phantom-meds.ts (dry-run first).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
