import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  _setMedicationIntakeImportPrismaForTests,
  processMedicationIntakeImportJob,
  type MedicationImportPayload,
  type MedicationImportProgress,
} from "@/lib/jobs/medication-intake-import";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { toJson } from "@/lib/db";

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  _setMedicationIntakeImportPrismaForTests(prisma);
  vi.clearAllMocks();
});

afterAll(() => {
  _setMedicationIntakeImportPrismaForTests(null);
});

describe("medication intake import job — concurrent retry", () => {
  it("produces one event and one inventory consumption per unique import key", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "med-import-owner",
        email: "med-import-owner@example.test",
        role: "USER",
        timezone: "Europe/Berlin",
      },
    });
    const medication = await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Test medication",
        dose: "1 tablet",
        unitsPerDose: 1,
      },
    });
    const inventory = await prisma.medicationInventoryItem.create({
      data: {
        userId: user.id,
        medicationId: medication.id,
        unitsTotal: 10,
        unitsRemaining: 10,
      },
    });

    const payload: MedicationImportPayload = {
      entries: [
        {
          scheduledFor: "2026-07-20T05:00:00.000Z",
          takenAt: "2026-07-20T05:00:00.000Z",
          idempotencyKey: `import-${medication.id}-1`,
        },
        {
          scheduledFor: "2026-07-20T05:00:00.000Z",
          takenAt: "2026-07-20T05:00:00.000Z",
          idempotencyKey: `import-${medication.id}-1`,
        },
        {
          scheduledFor: "2026-07-20T17:00:00.000Z",
          takenAt: "2026-07-20T17:00:00.000Z",
          idempotencyKey: `import-${medication.id}-2`,
        },
        {
          scheduledFor: "2026-07-21T05:00:00.000Z",
          takenAt: "2026-07-21T05:00:00.000Z",
          idempotencyKey: `import-${medication.id}-3`,
        },
      ],
    };
    const progress: MedicationImportProgress = {
      processed: 0,
      total: payload.entries.length,
      imported: 0,
      skippedByReason: {},
      touchedDays: [],
      rollupProcessed: 0,
    };
    const job = await prisma.medicationIntakeImportJob.create({
      data: {
        recordUserId: user.id,
        actorUserId: user.id,
        medicationId: medication.id,
        payload: toJson(payload),
        progress: toJson(progress),
      },
    });

    await Promise.all([
      processMedicationIntakeImportJob(job.id),
      processMedicationIntakeImportJob(job.id),
    ]);
    await processMedicationIntakeImportJob(job.id);

    const [events, refreshedInventory, rollups, refreshedJob, audits] =
      await Promise.all([
        prisma.medicationIntakeEvent.findMany({
          where: { userId: user.id, medicationId: medication.id },
          orderBy: { idempotencyKey: "asc" },
        }),
        prisma.medicationInventoryItem.findUniqueOrThrow({
          where: { id: inventory.id },
        }),
        prisma.medicationComplianceRollup.findMany({
          where: { userId: user.id, medicationId: medication.id },
          orderBy: { day: "asc" },
        }),
        prisma.medicationIntakeImportJob.findUniqueOrThrow({
          where: { id: job.id },
        }),
        prisma.auditLog.findMany({
          where: {
            userId: user.id,
            action: "medication.intake.import",
          },
        }),
      ]);

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.idempotencyKey)).toEqual([
      `import-${medication.id}-1`,
      `import-${medication.id}-2`,
      `import-${medication.id}-3`,
    ]);
    expect(
      events.every(
        (event) =>
          Array.isArray(event.inventoryConsumption) &&
          event.inventoryConsumption.length === 1,
      ),
    ).toBe(true);
    expect(Number(refreshedInventory.unitsRemaining)).toBe(7);
    expect(
      rollups.map(({ day, scheduled, taken }) => ({
        day,
        scheduled,
        taken,
      })),
    ).toEqual([
      { day: "2026-07-20", scheduled: 2, taken: 2 },
      { day: "2026-07-21", scheduled: 1, taken: 1 },
    ]);
    expect(refreshedJob.status).toBe("done");
    // The two entries sharing an instant collapse inside the submission; that
    // is `duplicate_in_file`, and it is reported under its own name rather
    // than as an undifferentiated "duplicate".
    expect(refreshedJob.result).toEqual({
      imported: 3,
      skipped: 1,
      skipReasons: [{ reason: "duplicate_in_file", count: 1 }],
    });
    expect(refreshedJob.progress).toEqual({
      processed: 4,
      total: 4,
      imported: 3,
      skippedByReason: { duplicate_in_file: 1 },
      // A job can now cover a whole regimen, so a day whose rollup needs
      // re-folding is addressed by medication AND day — two medications touched
      // on one day are two rollup rows, which a bare day key cannot name.
      touchedDays: [
        `${medication.id} 2026-07-20`,
        `${medication.id} 2026-07-21`,
      ],
      rollupProcessed: 2,
    });
    expect(audits).toHaveLength(1);
    expect(invalidateUserMedications).toHaveBeenCalledTimes(1);
    expect(queueMedicationIntakeSync).toHaveBeenCalledTimes(1);
  });

  it("rolls final effects back with a failed terminal marker and retries once", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "med-import-finalize",
        email: "med-import-finalize@example.test",
        role: "USER",
        timezone: "Europe/Berlin",
      },
    });
    const medication = await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Finalize medication",
        dose: "1 tablet",
        unitsPerDose: 1,
      },
    });
    const payload: MedicationImportPayload = {
      entries: [
        {
          scheduledFor: "2026-07-20T05:00:00.000Z",
          takenAt: "2026-07-20T05:00:00.000Z",
          idempotencyKey: `import-${medication.id}-final`,
        },
      ],
    };
    const progress: MedicationImportProgress = {
      processed: 0,
      total: 1,
      imported: 0,
      skippedByReason: {},
      touchedDays: [],
      rollupProcessed: 0,
    };
    const job = await prisma.medicationIntakeImportJob.create({
      data: {
        recordUserId: user.id,
        actorUserId: user.id,
        medicationId: medication.id,
        payload: toJson(payload),
        progress: toJson(progress),
      },
    });

    let rejectTerminalMarker = true;
    const clientWithTerminalFailure = {
      $transaction: (
        operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) =>
        prisma.$transaction(async (tx) => {
          const jobDelegate = new Proxy(tx.medicationIntakeImportJob, {
            get(target, property, receiver) {
              if (property !== "update") {
                return Reflect.get(target, property, receiver);
              }
              return async (
                args: Prisma.MedicationIntakeImportJobUpdateArgs,
              ) => {
                if (rejectTerminalMarker && args.data.status === "done") {
                  rejectTerminalMarker = false;
                  throw new Error("terminal marker failed");
                }
                return tx.medicationIntakeImportJob.update(args);
              };
            },
          });
          const transaction = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === "medicationIntakeImportJob") {
                return jobDelegate;
              }
              return Reflect.get(target, property, receiver);
            },
          });
          return operation(transaction);
        }),
    } as unknown as PrismaClient;

    _setMedicationIntakeImportPrismaForTests(clientWithTerminalFailure);
    await expect(processMedicationIntakeImportJob(job.id)).rejects.toThrow(
      "terminal marker failed",
    );

    const afterFailedFinalization = await Promise.all([
      prisma.medicationIntakeEvent.count({
        where: { medicationId: medication.id },
      }),
      prisma.medicationComplianceRollup.count({
        where: { medicationId: medication.id },
      }),
      prisma.auditLog.count({
        where: {
          userId: user.id,
          action: "medication.intake.import",
        },
      }),
      prisma.medicationIntakeImportJob.findUniqueOrThrow({
        where: { id: job.id },
      }),
    ]);
    expect(afterFailedFinalization[0]).toBe(1);
    expect(afterFailedFinalization[1]).toBe(0);
    expect(afterFailedFinalization[2]).toBe(0);
    expect(afterFailedFinalization[3].status).toBe("running");

    _setMedicationIntakeImportPrismaForTests(prisma);
    await processMedicationIntakeImportJob(job.id);
    await processMedicationIntakeImportJob(job.id);

    const [events, rollups, audits, completedJob] = await Promise.all([
      prisma.medicationIntakeEvent.findMany({
        where: { medicationId: medication.id },
      }),
      prisma.medicationComplianceRollup.findMany({
        where: { medicationId: medication.id },
      }),
      prisma.auditLog.findMany({
        where: {
          userId: user.id,
          action: "medication.intake.import",
        },
      }),
      prisma.medicationIntakeImportJob.findUniqueOrThrow({
        where: { id: job.id },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(rollups).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(completedJob.status).toBe("done");
  });
});
