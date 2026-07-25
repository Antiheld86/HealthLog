/**
 * v1.9.0 — `medicationAdministrations` aggregation + drug-code carry.
 *
 * Asserts the source rows the FHIR `MedicationAdministration` builder
 * consumes are assembled correctly from `MedicationIntakeEvent`:
 *   - a taken row → `completed` with `effectiveAt = takenAt`,
 *   - an explicit skip → `not-done` with `effectiveAt = scheduledFor`,
 *   - a pending / missed slot (no `takenAt`, not skipped) → omitted,
 *   - a soft-deleted tombstone → omitted,
 *   - the structured dose-in-effect resolved from `MedicationDoseChange`,
 *   - the medication's `atcCode` / `rxNormCode` carried onto both the
 *     `medications[]` concept and each administration row.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { selectionFromLeaves } from "@/lib/report-selection/selection";

import { getPrismaClient, truncateAllTables } from "./setup";

const RANGE = {
  start: new Date("2026-01-01T00:00:00.000Z"),
  end: new Date("2026-06-01T00:00:00.000Z"),
  days: 152,
};

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("medicationAdministrations aggregation (v1.9.0)", () => {
  it("maps acted intakes, omits missed + tombstoned, resolves dose-in-effect", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: { username: "admin-agg", email: "admin-agg@example.test" },
    });

    const med = await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Mounjaro",
        dose: "10mg",
        active: true,
        treatmentClass: "GLP1",
        deliveryForm: "INJECTION",
        atcCode: "A10BX10",
        rxNormCode: "2601723",
      },
    });

    // Dose-change history: 5mg from Feb, stepped to 10mg from Apr.
    await prisma.medicationDoseChange.createMany({
      data: [
        {
          medicationId: med.id,
          effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
          doseValue: 5,
          doseUnit: "mg",
        },
        {
          medicationId: med.id,
          effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
          doseValue: 10,
          doseUnit: "mg",
        },
      ],
    });

    // A taken dose in March (dose-in-effect = 5mg) with a site.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: med.id,
        scheduledFor: new Date("2026-03-15T08:00:00.000Z"),
        takenAt: new Date("2026-03-15T08:12:00.000Z"),
        injectionSite: "ABDOMEN_LEFT",
      },
    });
    // A skipped dose in April.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: med.id,
        scheduledFor: new Date("2026-04-15T08:00:00.000Z"),
        skipped: true,
      },
    });
    // A missed slot (no takenAt, not skipped) — must be omitted.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: med.id,
        scheduledFor: new Date("2026-05-01T08:00:00.000Z"),
      },
    });
    // A soft-deleted (tombstoned) taken dose — must be omitted.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: med.id,
        scheduledFor: new Date("2026-05-10T08:00:00.000Z"),
        takenAt: new Date("2026-05-10T08:05:00.000Z"),
        deletedAt: new Date("2026-05-11T00:00:00.000Z"),
      },
    });

    const data = await collectDoctorReportData(
      user.id,
      RANGE,
      selectionFromLeaves([
        "MEDICATION_LIST",
        "MEDICATION_ADMINISTRATIONS",
        "MEDICATION_COMPLIANCE",
      ]),
    );

    // Drug codes carried onto the medication concept source.
    expect(data.medications[0].atcCode).toBe("A10BX10");
    expect(data.medications[0].rxNormCode).toBe("2601723");

    const admins = data.medicationAdministrations ?? [];
    // Only the taken + skipped rows survive.
    expect(admins).toHaveLength(2);

    const taken = admins.find((a) => a.status === "completed");
    expect(taken).toBeDefined();
    expect(taken?.effectiveAt).toBe("2026-03-15T08:12:00.000Z");
    expect(taken?.injectionSite).toBe("ABDOMEN_LEFT");
    expect(taken?.deliveryForm).toBe("INJECTION");
    expect(taken?.atcCode).toBe("A10BX10");
    // Dose-in-effect at 2026-03-15 is the 5mg step (not yet 10mg).
    expect(taken?.dose).toEqual({ value: 5, unit: "mg" });

    const skipped = admins.find((a) => a.status === "not-done");
    expect(skipped).toBeDefined();
    // A skip uses scheduledFor and records no consumed dose.
    expect(skipped?.effectiveAt).toBe("2026-04-15T08:00:00.000Z");
    expect(skipped?.dose).toBeNull();
  });
});
