import { beforeEach, describe, expect, it } from "vitest";

import { toJson } from "@/lib/db";
import {
  _setMedicationIntakeImportPrismaForTests,
  processMedicationIntakeImportJob,
  type MedicationImportProgress,
} from "@/lib/jobs/medication-intake-import";

import { getPrismaClient, truncateAllTables } from "./setup";

const EMPTY_PROGRESS: MedicationImportProgress = {
  processed: 0,
  total: 0,
  imported: 0,
  skippedByReason: {},
  touchedDays: [],
  rollupProcessed: 0,
};

beforeEach(async () => {
  const prisma = getPrismaClient();
  _setMedicationIntakeImportPrismaForTests(prisma);
  await truncateAllTables(prisma);
});

describe("shared intake import attribution", () => {
  it("retains the record and manager through one durable completion audit", async () => {
    const prisma = getPrismaClient();
    await prisma.user.createMany({
      data: [
        {
          id: "import-record",
          username: "import-record",
          email: "import-record@example.test",
          role: "USER",
        },
        {
          id: "import-manager",
          username: "import-manager",
          email: "import-manager@example.test",
          role: "USER",
        },
      ],
    });
    const job = await prisma.medicationIntakeImportJob.create({
      data: {
        recordUserId: "import-record",
        actorUserId: "import-manager",
        medicationId: null,
        payload: toJson({ entries: [] }),
        progress: toJson(EMPTY_PROGRESS),
      } as never,
    });

    await processMedicationIntakeImportJob(job.id);
    await processMedicationIntakeImportJob(job.id);

    const [completed, audits] = await Promise.all([
      prisma.medicationIntakeImportJob.findUniqueOrThrow({
        where: { id: job.id },
      }),
      prisma.auditLog.findMany({
        where: {
          userId: "import-record",
          action: "medication.intake.import",
        },
      }),
    ]);

    expect(completed).toMatchObject({
      recordUserId: "import-record",
      actorUserId: "import-manager",
      status: "done",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: "import-record",
      actorUserId: "import-manager",
    });
    expect(JSON.parse(audits[0]!.details!)).toEqual({
      jobId: job.id,
      recordUserId: "import-record",
      actorUserId: "import-manager",
      imported: 0,
      skipped: 0,
      total: 0,
    });
  });
});
