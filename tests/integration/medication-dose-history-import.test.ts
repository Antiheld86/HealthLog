/**
 * The reported export, from file text to rows in Postgres.
 *
 * A self-hoster attached a 3,395-row dose history covering sixteen medications
 * across three and a half years, two UTC offsets, and three statuses. They had
 * been hand-mapping it into the two-field shape the intake importer accepted,
 * which is where the scheduled time and the time taken collapse into one.
 *
 * A mocked Prisma cannot show whether that survived. The claim is about rows: how
 * many exist afterwards, what instants they carry, and that the pair the file
 * kept apart is still two columns. So the real file goes through the real
 * derivation into a real Postgres and the assertions are counts and instants read
 * back out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { toJson } from "@/lib/db";
import {
  _setMedicationIntakeImportPrismaForTests,
  processMedicationIntakeImportJob,
} from "@/lib/jobs/medication-intake-import";
import { parseAutoExportCsv } from "@/lib/medications/import/auto-export-parse";
import { planAutoExportImport } from "@/lib/medications/import/auto-export-plan";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

/** The export as it arrived, de-identified, byte for byte. */
const FIXTURE = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "src/lib/medications/import/__tests__/fixtures/dose-history-export.csv",
  ),
  "utf8",
);

/** After the newest row, so the plausibility bound is fixed rather than today's. */
const NOW = Date.parse("2026-07-01T00:00:00.000Z");

const MEDICATION_NAMES = Array.from(
  { length: 16 },
  (_, index) => `Med_${index + 1}`,
);

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  _setMedicationIntakeImportPrismaForTests(prisma);
  vi.clearAllMocks();
});

afterAll(() => {
  _setMedicationIntakeImportPrismaForTests(null);
});

async function seedRegimen(names: readonly string[] = MEDICATION_NAMES) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "dose-history",
      email: "dose-history@example.test",
      role: "USER",
      // Deliberately not the export's own zone: the offsets in the file decide
      // the instants, and the user's zone decides only which local day each dose
      // rolls up into. Sharing one zone would hide a mistake in either.
      timezone: "Europe/Berlin",
    },
  });
  for (const name of names) {
    await prisma.medication.create({
      data: { userId: user.id, name, dose: "1 tablet", unitsPerDose: 1 },
    });
  }
  return user;
}

/** The production derivation, not a restatement of it. */
async function enqueue(userId: string) {
  const prisma = getPrismaClient();
  const medications = await prisma.medication.findMany({
    where: { userId },
    select: { id: true, name: true, externalSource: true },
  });
  const plan = planAutoExportImport(
    parseAutoExportCsv(FIXTURE, { now: NOW }),
    medications,
  );
  const job = await prisma.medicationIntakeImportJob.create({
    data: {
      recordUserId: userId,
      actorUserId: userId,
      // Account-wide: the file covers sixteen medications, so no single one owns
      // the job and each entry names its own.
      medicationId: null,
      payload: toJson({ entries: plan.entries }),
      progress: toJson({
        processed: 0,
        total: plan.entries.length,
        imported: 0,
        skippedByReason: plan.skippedByReason,
        skipDetails: plan.skipDetails,
        skippedDetailsOmitted: plan.skippedDetailsOmitted,
        touchedDays: [],
        rollupProcessed: 0,
      }),
    },
  });
  return { jobId: job.id, plan };
}

describe("dose-history import — the reported export end to end", () => {
  it("lands every dose the file records a decision for", async () => {
    const prisma = getPrismaClient();
    const user = await seedRegimen();
    const { jobId, plan } = await enqueue(user.id);

    const result = await processMedicationIntakeImportJob(jobId);

    expect(result).toEqual({
      imported: 3387,
      skipped: 8,
      // The eight `Not Interacted` rows: the file states no decision about those
      // doses, so there is nothing honest to write, and the count says which.
      skipReasons: [{ reason: "status_no_dose_information", count: 8 }],
      skipDetails: plan.skipDetails,
      skippedDetailsOmitted: 0,
    });
    // Every row of the file is accounted for by one of the two numbers.
    expect(result!.imported + result!.skipped).toBe(3395);

    await expect(
      prisma.medicationIntakeEvent.count({ where: { userId: user.id } }),
    ).resolves.toBe(3387);
    const sources = await prisma.medicationIntakeEvent.findMany({
      where: { userId: user.id },
      distinct: ["source"],
      select: { source: true },
    });
    expect(sources.map((row) => row.source)).toEqual(["IMPORT"]);
  }, 240_000);

  it("keeps the scheduled slot and the take as two facts", async () => {
    const prisma = getPrismaClient();
    const user = await seedRegimen();
    const { jobId } = await enqueue(user.id);
    await processMedicationIntakeImportJob(jobId);

    const med13 = await prisma.medication.findFirstOrThrow({
      where: { userId: user.id, name: "Med_13" },
    });
    // Row 2 of the file: `2023-02-16 08:38:00 +1030` taken against a
    // `2023-02-16 08:00:00 +1030` slot. Both offsets survive to the second.
    const first = await prisma.medicationIntakeEvent.findFirstOrThrow({
      where: { userId: user.id, medicationId: med13.id },
      orderBy: { scheduledFor: "asc" },
    });
    expect(first.scheduledFor.toISOString()).toBe("2023-02-15T21:30:00.000Z");
    expect(first.takenAt?.toISOString()).toBe("2023-02-15T22:08:00.000Z");
    expect(first.skipped).toBe(false);

    const late = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "medication_intake_events"
      WHERE "user_id" = ${user.id}
        AND "taken_at" > "scheduled_for"
    `;
    // 2,799 doses landed after they were due. Anchoring each on its own take
    // time — all the old two-field payload could express — would have written
    // 3,366 doses that every compliance read then calls perfectly on time.
    expect(Number(late[0].count)).toBe(2799);
  }, 240_000);

  it("writes a skip as a dose not taken, not as a take", async () => {
    const prisma = getPrismaClient();
    const user = await seedRegimen();
    const { jobId } = await enqueue(user.id);
    await processMedicationIntakeImportJob(jobId);

    const skips = await prisma.medicationIntakeEvent.findMany({
      where: { userId: user.id, skipped: true },
      select: { takenAt: true, doseTaken: true },
    });
    expect(skips).toHaveLength(21);
    for (const skip of skips) {
      expect(skip.takenAt).toBeNull();
      expect(skip.doseTaken).toBeNull();
    }
  }, 240_000);

  it("records a per-dose amount only where the file says the dose deviated", async () => {
    const prisma = getPrismaClient();
    const user = await seedRegimen();
    const { jobId } = await enqueue(user.id);
    await processMedicationIntakeImportJob(jobId);

    const overridden = await prisma.medicationIntakeEvent.findMany({
      where: { userId: user.id, doseTaken: { not: null } },
      select: { doseTaken: true },
    });
    expect(overridden).toHaveLength(25);
    expect(new Set(overridden.map((row) => row.doseTaken))).toEqual(
      new Set(["0.25", "0.5", "1", "1.25", "2"]),
    );
  }, 240_000);

  it("re-importing the same file adds nothing and says why", async () => {
    const prisma = getPrismaClient();
    const user = await seedRegimen();
    const first = await enqueue(user.id);
    await processMedicationIntakeImportJob(first.jobId);

    const second = await enqueue(user.id);
    const result = await processMedicationIntakeImportJob(second.jobId);

    expect(result).toMatchObject({
      imported: 0,
      skipped: 3395,
      skipReasons: [
        { reason: "already_recorded", count: 3387 },
        { reason: "status_no_dose_information", count: 8 },
      ],
    });
    expect(result?.skipDetails).toHaveLength(200);
    expect(result?.skipDetails?.slice(0, 8)).toEqual(second.plan.skipDetails);
    expect(result?.skippedDetailsOmitted).toBe(3195);
    const detailWire = JSON.stringify(result?.skipDetails);
    expect(detailWire).not.toContain("Med_");
    expect(detailWire).not.toContain("scheduledFor");
    expect(detailWire).not.toContain("takenAt");
    await expect(
      prisma.medicationIntakeEvent.count({ where: { userId: user.id } }),
    ).resolves.toBe(3387);
  }, 480_000);

  it("refuses the rows of a medication that is not on the record, by name", async () => {
    const prisma = getPrismaClient();
    const user = await seedRegimen(["Med_13", "Med_9"]);
    const { jobId, plan } = await enqueue(user.id);

    const result = await processMedicationIntakeImportJob(jobId);

    expect(plan.unmatchedMedications).toHaveLength(14);
    expect(result!.imported).toBe(plan.entries.length);
    expect(result!.imported + result!.skipped).toBe(3395);
    expect(
      result!.skipReasons.find(
        (group) => group.reason === "medication_not_found",
      )?.count,
    ).toBe(3387 - plan.entries.length);
    // Nothing was created to hold the refused rows.
    await expect(
      prisma.medication.count({ where: { userId: user.id } }),
    ).resolves.toBe(2);
  }, 240_000);

  it("imports an inactive medication's history without putting it back on the active list", async () => {
    const prisma = getPrismaClient();
    const user = await seedRegimen();
    // Standing in for a medication archived in the source app: the person has
    // stopped taking it here too. Importing the history it names is one act;
    // making the medication current again is a different one, and only the first
    // was asked for. Someone re-adding it later should find the history waiting,
    // not find it already re-added on their behalf.
    await prisma.medication.updateMany({
      where: { userId: user.id },
      data: { active: false },
    });

    const { jobId } = await enqueue(user.id);
    const result = await processMedicationIntakeImportJob(jobId);

    expect(result!.imported).toBe(3387);
    const stillInactive = await prisma.medication.count({
      where: { userId: user.id, active: false },
    });
    expect(stillInactive).toBe(16);
  }, 240_000);

  it("re-folds the compliance rollup for every medication and day it touched", async () => {
    const prisma = getPrismaClient();
    const user = await seedRegimen();
    const { jobId } = await enqueue(user.id);
    await processMedicationIntakeImportJob(jobId);

    const rollups = await prisma.medicationComplianceRollup.findMany({
      where: { userId: user.id },
      select: { medicationId: true, day: true },
    });
    // One rollup row per (medication, local day) the import wrote into. The job
    // spans sixteen medications, so a bare day key could not have addressed
    // them — two medications on one day are two rows.
    expect(rollups.length).toBeGreaterThan(3000);
    expect(new Set(rollups.map((row) => row.medicationId)).size).toBe(16);
    expect(
      new Set(rollups.map((row) => `${row.medicationId} ${row.day}`)).size,
    ).toBe(rollups.length);
  }, 480_000);
});
