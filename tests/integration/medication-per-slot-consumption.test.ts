/**
 * #219 — per-schedule units-per-dose consumption.
 *
 * A medication owns two schedules at different times of day, each with its own
 * `unitsPerDose`: a whole tablet in the morning, a half at noon. The intake
 * consume hook must decrement the SLOT's unit count, not the medication-level
 * one, so a noon half-dose draws 0.5 tablets while a morning dose draws 1.
 *
 * A unit test with a mocked client cannot prove this: the hook resolves the
 * slot by binding the intake's `scheduledFor` wall-clock time (in the user's
 * zone) to a schedule, then reads that schedule's Decimal column. This drives
 * the real consume hook against a testcontainers Postgres so the Decimal, the
 * timezone match, and the inventory decrement are all real.
 *
 * Requires Docker / OrbStack; runs under `pnpm test:integration`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { consumeForIntake } from "@/lib/medications/inventory/consumption";
import type { PrismaClient } from "@/generated/prisma/client";

const USER_ID = "per-slot-units-user";

/** Sum of the units the intake event's consumption stamp recorded. */
async function consumedUnits(
  prisma: PrismaClient,
  eventId: string,
): Promise<number> {
  const row = await prisma.medicationIntakeEvent.findUniqueOrThrow({
    where: { id: eventId },
    select: { inventoryConsumption: true },
  });
  const stamp = row.inventoryConsumption;
  if (!Array.isArray(stamp)) return 0;
  return stamp.reduce<number>(
    (sum, entry) =>
      sum +
      (entry &&
      typeof entry === "object" &&
      typeof (entry as { units?: unknown }).units === "number"
        ? (entry as { units: number }).units
        : 0),
    0,
  );
}

async function takeDose(
  prisma: PrismaClient,
  medicationId: string,
  scheduledFor: Date,
): Promise<string> {
  const event = await prisma.medicationIntakeEvent.create({
    data: {
      userId: USER_ID,
      medicationId,
      scheduledFor,
      takenAt: scheduledFor,
    },
    select: { id: true },
  });
  await consumeForIntake({
    client: prisma,
    userId: USER_ID,
    medicationId,
    eventId: event.id,
    intakeAt: scheduledFor,
  });
  return event.id;
}

describe("#219 per-schedule units-per-dose consumption — integration", () => {
  let medicationId: string;

  beforeEach(async () => {
    const prisma = getPrismaClient();
    await truncateAllTables(prisma);
    // Zone fixed to UTC so a `scheduledFor` at 08:00Z / 12:00Z reads back as
    // the "08:00" / "12:00" wall clock the schedules name.
    await prisma.user.create({
      data: {
        id: USER_ID,
        username: "per-slot-units",
        email: "per-slot-units@example.test",
        timezone: "UTC",
      },
    });
    const med = await prisma.medication.create({
      data: {
        userId: USER_ID,
        name: "Split tablet",
        dose: "10mg",
        deliveryForm: "ORAL",
        // Medication-level default is a WHOLE unit; the noon slot overrides it.
        unitsPerDose: 1,
        schedules: {
          create: [
            {
              windowStart: "08:00",
              windowEnd: "09:00",
              timesOfDay: ["08:00"],
              rrule: "FREQ=DAILY",
              unitsPerDose: 1,
            },
            {
              windowStart: "12:00",
              windowEnd: "13:00",
              timesOfDay: ["12:00"],
              rrule: "FREQ=DAILY",
              unitsPerDose: 0.5,
            },
          ],
        },
      },
      select: { id: true },
    });
    medicationId = med.id;
    // One open container with ample stock so neither dose floors at zero.
    await prisma.medicationInventoryItem.create({
      data: {
        userId: USER_ID,
        medicationId,
        state: "IN_USE",
        containerType: "BOTTLE",
        unitsTotal: 100,
        unitsRemaining: 100,
        firstUseAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
  });

  it("draws 1 unit for the morning slot and 0.5 for the noon slot", async () => {
    const prisma = getPrismaClient();

    const morning = await takeDose(
      prisma,
      medicationId,
      new Date("2026-08-10T08:00:00.000Z"),
    );
    const noon = await takeDose(
      prisma,
      medicationId,
      new Date("2026-08-10T12:00:00.000Z"),
    );

    // The morning slot (unitsPerDose 1) draws a whole unit; the noon slot
    // (unitsPerDose 0.5) draws a half. This is the assertion that goes RED
    // when the hook reads only the medication-level column.
    expect(await consumedUnits(prisma, morning)).toBe(1);
    expect(await consumedUnits(prisma, noon)).toBe(0.5);

    const item = await prisma.medicationInventoryItem.findFirstOrThrow({
      where: { medicationId },
      select: { unitsRemaining: true },
    });
    expect(Number(item.unitsRemaining)).toBe(98.5);
  });
});
