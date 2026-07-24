/**
 * Remove the phantom Apple-Health mirror medications minted by the unstable
 * externalId bug (a fresh key per sync sweep => one duplicate row per sweep).
 *
 * SAFETY:
 *   - Dry-run by default. Deletes ONLY when called with `--execute`.
 *   - Targets ONLY rows that match ALL of: the given name, externalSource =
 *     APPLE_HEALTH, ZERO intake events, and ZERO schedules. A row with any
 *     intake history or any schedule is never touched. Real medications
 *     (different name, or with intake/schedule history) can never match.
 *   - Each delete replicates the DELETE /api/medications/{id} route exactly:
 *     revoke medication-scoped tokens, deleteMedicationCategory, cascade
 *     delete, audit row. Caches are busted per affected user at the end (and
 *     otherwise clear on TTL / the next write).
 *
 * STOP THE SOURCE FIRST: while the iOS Apple-Health medication mirror is still
 * enabled on the device, every sync re-mints these rows and cleanup will undo
 * itself. Turn the toggle off (or ship the iOS fix) before running --execute.
 *
 * Run (inside the app container):
 *   pnpm dlx tsx scripts/cleanup-apple-health-phantom-meds.ts            # dry-run
 *   pnpm dlx tsx scripts/cleanup-apple-health-phantom-meds.ts --execute  # delete
 *   pnpm dlx tsx scripts/cleanup-apple-health-phantom-meds.ts --name "Blutdruckmittel" --execute
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { deleteMedicationCategory } from "@/lib/medication-category";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const name = argValue("--name") ?? "Blutdruckmittel";
  const execute = process.argv.includes("--execute");

  // Candidate set: name + Apple-Health provenance only. Intake / schedule
  // counts are checked per row below and are the hard safety gate.
  const candidates = await prisma.medication.findMany({
    where: { name, externalSource: "APPLE_HEALTH" },
    select: { id: true, userId: true, externalId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const deletable: { id: string; userId: string }[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const m of candidates) {
    const [intakes, schedules] = await Promise.all([
      prisma.medicationIntakeEvent.count({
        where: { medicationId: m.id, deletedAt: null },
      }),
      prisma.medicationSchedule.count({ where: { medicationId: m.id } }),
    ]);
    if (intakes > 0 || schedules > 0) {
      skipped.push({
        id: m.id,
        reason: `has ${intakes} intake(s) / ${schedules} schedule(s) — PRESERVED`,
      });
      continue;
    }
    deletable.push({ id: m.id, userId: m.userId });
  }

  console.log(`\n=== cleanup plan for name "${name}" (externalSource APPLE_HEALTH) ===`);
  console.log(`candidates found:   ${candidates.length}`);
  console.log(`safe to delete:     ${deletable.length}`);
  console.log(`preserved (intake/schedule present): ${skipped.length}`);
  if (skipped.length > 0) {
    console.log("\nPreserved rows:");
    for (const s of skipped) console.log(`  ${s.id} — ${s.reason}`);
  }
  console.log("\nRows to delete:");
  for (const d of deletable) console.log(`  ${d.id}`);

  if (!execute) {
    console.log(
      "\nDRY RUN — nothing was deleted. Re-run with --execute to remove the rows above.",
    );
    return;
  }

  console.log(`\n--execute: deleting ${deletable.length} row(s)...`);
  const affectedUsers = new Set<string>();
  let deleted = 0;
  for (const { id, userId } of deletable) {
    // Mirror the DELETE route: revoke medication-scoped tokens (none expected
    // on a phantom row, harmless if absent), category cleanup, cascade delete,
    // audit row.
    await prisma.apiToken.updateMany({
      where: {
        userId,
        revoked: false,
        permissions: { has: `medication:${id}:ingest` },
      },
      data: { revoked: true },
    });
    await deleteMedicationCategory(id);
    await prisma.medication.delete({ where: { id } });
    await auditLog("medication.delete", {
      userId,
      details: { medicationId: id, name, reason: "apple_health_phantom_cleanup" },
    });
    affectedUsers.add(userId);
    deleted += 1;
  }

  for (const userId of affectedUsers) {
    invalidateUserMedications(userId, { evict: true });
  }

  console.log(`\nDone. Deleted ${deleted} row(s) across ${affectedUsers.size} user(s).`);
  console.log(
    "Caches were busted for the affected users; a page refresh reflects the change.",
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
