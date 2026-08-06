/**
 * #650 — the reported export, from the request body to the rows on the ledger.
 *
 * A self-hoster attached a 28-dose file: one intake per day for four weeks, all
 * at 08:30, with `"zaehler": 1.0` on every row. The route accepted it, answered
 * 202, and one intake landed. The other 27 were reported back as duplicates —
 * of each other, because the replay key was built from `zaehler` and every row
 * carried the same value.
 *
 * A mocked Prisma cannot show this: the collapse is half in the key derivation
 * and half in two database uniques (`(user_id, idempotency_key)` and the
 * live-row slot unique). So the real file goes through the real route into a
 * real Postgres here, and the assertion is the count of rows that exist
 * afterwards.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  _setMedicationIntakeImportPrismaForTests,
  processMedicationIntakeImportJob,
} from "@/lib/jobs/medication-intake-import";
import { buildMedicationImportEntries } from "@/lib/medications/intake-import-payload";
import { toJson } from "@/lib/db";

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

/** The file attached to the report, byte for byte. */
const REPORTED_EXPORT = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "src/app/api/medications/[id]/intake/import/__tests__/fixtures/reported-intake-export.json",
    ),
    "utf8",
  ),
) as Array<{ datum: string; uhrzeit: string; zaehler: number }>;

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  _setMedicationIntakeImportPrismaForTests(prisma);
  vi.clearAllMocks();
});

afterAll(() => {
  _setMedicationIntakeImportPrismaForTests(null);
});

async function seedMedication() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "reported-export",
      email: "reported-export@example.test",
      role: "USER",
      timezone: "Europe/Berlin",
    },
  });
  const medication = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Reported medication",
      dose: "1 tablet",
      unitsPerDose: 1,
    },
  });
  return { user, medication };
}

/** The route's own derivation, so the fix is what is under test — not a mirror. */
function normalise(medicationId: string) {
  return {
    entries: buildMedicationImportEntries(medicationId, REPORTED_EXPORT),
  };
}

describe("medication intake import — the reported 28-dose export", () => {
  it("writes one row per dose instead of one row for the whole file", async () => {
    const prisma = getPrismaClient();
    const { user, medication } = await seedMedication();
    const payload = normalise(medication.id);

    const job = await prisma.medicationIntakeImportJob.create({
      data: {
        recordUserId: user.id,
        actorUserId: user.id,
        medicationId: medication.id,
        payload: toJson(payload),
        progress: toJson({
          processed: 0,
          total: payload.entries.length,
          imported: 0,
          skippedByReason: {},
          touchedDays: [],
          rollupProcessed: 0,
        }),
      },
    });

    const result = await processMedicationIntakeImportJob(job.id);

    expect(result).toEqual({ imported: 28, skipped: 0, skipReasons: [] });

    const events = await prisma.medicationIntakeEvent.findMany({
      where: { userId: user.id, medicationId: medication.id },
      orderBy: { takenAt: "asc" },
      select: { takenAt: true, source: true, idempotencyKey: true },
    });
    expect(events).toHaveLength(28);
    expect(new Set(events.map((event) => event.idempotencyKey)).size).toBe(28);
    expect(events.every((event) => event.source === "IMPORT")).toBe(true);
    // Every submitted day is on the ledger — the point of the whole import.
    expect(
      events.map((event) => event.takenAt?.toISOString().slice(0, 10)),
    ).toEqual(REPORTED_EXPORT.map((row) => row.datum));
  });

  it("re-importing the same file adds nothing and says why", async () => {
    const prisma = getPrismaClient();
    const { user, medication } = await seedMedication();
    const payload = normalise(medication.id);
    const progress = {
      processed: 0,
      total: payload.entries.length,
      imported: 0,
      skippedByReason: {},
      touchedDays: [],
      rollupProcessed: 0,
    };

    const first = await prisma.medicationIntakeImportJob.create({
      data: {
        recordUserId: user.id,
        actorUserId: user.id,
        medicationId: medication.id,
        payload: toJson(payload),
        progress: toJson(progress),
      },
    });
    await processMedicationIntakeImportJob(first.id);

    const second = await prisma.medicationIntakeImportJob.create({
      data: {
        recordUserId: user.id,
        actorUserId: user.id,
        medicationId: medication.id,
        payload: toJson(payload),
        progress: toJson(progress),
      },
    });
    const result = await processMedicationIntakeImportJob(second.id);

    expect(result).toEqual({
      imported: 0,
      skipped: 28,
      skipReasons: [{ reason: "already_recorded", count: 28 }],
      skipDetails: Array.from({ length: 28 }, (_, index) => ({
        line: index + 1,
        reason: "already_recorded",
      })),
      skippedDetailsOmitted: 0,
    });
    await expect(
      prisma.medicationIntakeEvent.count({
        where: { userId: user.id, medicationId: medication.id },
      }),
    ).resolves.toBe(28);
  });

  it("counts a within-file collision apart from an already-recorded dose", async () => {
    const prisma = getPrismaClient();
    const { user, medication } = await seedMedication();

    // One dose already on the ledger, from any surface at all.
    const existing = new Date("2026-05-31T08:30:00");
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: medication.id,
        scheduledFor: existing,
        takenAt: existing,
        source: "IMPORT",
        idempotencyKey: `import-${medication.id}-${existing.getTime()}`,
      },
    });

    // A submission that repeats one of its own rows AND repeats that dose.
    const duplicated = new Date("2026-06-05T08:30:00");
    const entries = [
      {
        takenAt: existing.toISOString(),
        idempotencyKey: `import-${medication.id}-${existing.getTime()}`,
      },
      {
        takenAt: duplicated.toISOString(),
        idempotencyKey: `import-${medication.id}-${duplicated.getTime()}`,
      },
      {
        takenAt: duplicated.toISOString(),
        idempotencyKey: `import-${medication.id}-${duplicated.getTime()}`,
      },
    ];

    const job = await prisma.medicationIntakeImportJob.create({
      data: {
        recordUserId: user.id,
        actorUserId: user.id,
        medicationId: medication.id,
        payload: toJson({ entries }),
        progress: toJson({
          processed: 0,
          total: entries.length,
          imported: 0,
          skippedByReason: {},
          touchedDays: [],
          rollupProcessed: 0,
        }),
      },
    });

    const result = await processMedicationIntakeImportJob(job.id);

    expect(result).toEqual({
      imported: 1,
      skipped: 2,
      skipReasons: [
        { reason: "already_recorded", count: 1 },
        { reason: "duplicate_in_file", count: 1 },
      ],
    });
    await expect(
      prisma.medicationIntakeEvent.count({
        where: { userId: user.id, medicationId: medication.id },
      }),
    ).resolves.toBe(2);
  });
});
