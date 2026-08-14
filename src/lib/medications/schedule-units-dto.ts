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
 *
 * v1.37.19 (iOS #25 parity) — every schedule additionally carries
 * `resolvedUnitsPerDose`: the EFFECTIVE units this slot consumes, resolved
 * server-side (`schedule.unitsPerDose ?? medication.unitsPerDose`, matching
 * the consumption resolver's >0 guard). Publish the resolved value; no
 * client re-derives the inheritance rule. The raw nullable `unitsPerDose`
 * stays beside it because the edit surface must distinguish "explicit"
 * from "inherits".
 */
import type { Prisma } from "@/generated/prisma/client";

type ScheduleWithUnits = { unitsPerDose: Prisma.Decimal | null };

export function serializeScheduleUnitsPerDose<T extends ScheduleWithUnits>(
  schedules: readonly T[],
  medicationUnitsPerDose: Prisma.Decimal | number,
): Array<
  Omit<T, "unitsPerDose"> & {
    unitsPerDose: number | null;
    resolvedUnitsPerDose: number;
  }
> {
  const fallback = Number(medicationUnitsPerDose);
  return schedules.map((schedule) => {
    const raw =
      schedule.unitsPerDose === null ? null : Number(schedule.unitsPerDose);
    return {
      ...schedule,
      unitsPerDose: raw,
      resolvedUnitsPerDose: raw !== null && raw > 0 ? raw : fallback,
    };
  });
}
