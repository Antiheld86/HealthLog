/**
 * #219 — per-schedule `unitsPerDose` wire serialisation.
 *
 * The column is a nullable `Decimal(10,4)`; Prisma serialises a Decimal to a
 * JSON STRING, which the client would then have to coerce. The medication-level
 * `unitsPerDose` is already unwrapped to a JSON number at every response point
 * (`Number(medication.unitsPerDose)`), so mirror that for the per-schedule
 * column: convert to a number, keep NULL as NULL (NULL means "inherit the
 * medication level"). One helper so the five medication read/write responses
 * cannot drift on the shape.
 */
import type { Prisma } from "@/generated/prisma/client";

type ScheduleWithUnits = { unitsPerDose: Prisma.Decimal | null };

export function serializeScheduleUnitsPerDose<T extends ScheduleWithUnits>(
  schedules: readonly T[],
): Array<Omit<T, "unitsPerDose"> & { unitsPerDose: number | null }> {
  return schedules.map((schedule) => ({
    ...schedule,
    unitsPerDose:
      schedule.unitsPerDose === null ? null : Number(schedule.unitsPerDose),
  }));
}
