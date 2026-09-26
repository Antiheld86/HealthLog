/**
 * A doctor report whose window ends in the past describes that window only.
 *
 * A share link can pin the end date. The medication list, the dose history
 * and the last injection were read as of today, so a report for the first
 * quarter listed a medication started in June, a dose set in June and an
 * injection logged last week.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { ALL_LEAF_IDS } from "@/lib/report-selection/catalogue";
import { selectionFromLeaves } from "@/lib/report-selection/selection";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const RANGE = {
  start: new Date("2026-01-01T00:00:00.000Z"),
  end: new Date("2026-03-31T23:59:59.999Z"),
  days: 90,
};

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("doctor report with a fixed end date", () => {
  it("leaves out medications, doses and injections that came after the window", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "fixed-window",
        email: "fixed-window@example.test",
        timezone: "UTC",
      },
    });
    const during = await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Semaglutide",
        dose: "0.5 mg",
        treatmentClass: "GLP1",
        startsOn: new Date("2026-01-10T00:00:00.000Z"),
        createdAt: new Date("2026-01-10T00:00:00.000Z"),
      },
    });
    await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Started later",
        dose: "10 mg",
        startsOn: new Date("2026-06-01T00:00:00.000Z"),
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });
    await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Entered later, no start date",
        dose: "5 mg",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    // Entered after the window, but with a dose scheduled inside it: it was
    // taken then, so it belongs on the report.
    const enteredLater = await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Entered later, taken in March",
        dose: "20 mg",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: enteredLater.id,
        scheduledFor: new Date("2026-03-05T08:00:00.000Z"),
        takenAt: new Date("2026-03-05T08:10:00.000Z"),
      },
    });
    await prisma.medicationDoseChange.createMany({
      data: [
        {
          medicationId: during.id,
          effectiveFrom: new Date("2026-01-10T00:00:00.000Z"),
          doseValue: 0.25,
          doseUnit: "mg",
        },
        {
          medicationId: during.id,
          effectiveFrom: new Date("2026-06-15T00:00:00.000Z"),
          doseValue: 1,
          doseUnit: "mg",
        },
      ],
    });
    await prisma.medicationIntakeEvent.createMany({
      data: [
        {
          userId: user.id,
          medicationId: during.id,
          scheduledFor: new Date("2026-03-20T08:00:00.000Z"),
          takenAt: new Date("2026-03-20T08:05:00.000Z"),
        },
        {
          userId: user.id,
          medicationId: during.id,
          scheduledFor: new Date("2026-07-20T08:00:00.000Z"),
          takenAt: new Date("2026-07-20T08:05:00.000Z"),
        },
      ],
    });

    const data = await collectDoctorReportData(
      user.id,
      RANGE,
      selectionFromLeaves(ALL_LEAF_IDS),
    );

    expect(data.medications?.map((m) => m.name).sort()).toEqual([
      "Entered later, taken in March",
      "Semaglutide",
    ]);
    const glp1 = data.glp1?.medications[0];
    expect(glp1?.doseHistory.map((d) => d.value)).toEqual([0.25]);
    expect(glp1?.currentDose?.value).toBe(0.25);
    expect(glp1?.lastInjection?.date).toBe("2026-03-20T08:05:00.000Z");
  });
});
