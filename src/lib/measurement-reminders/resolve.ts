/**
 * v1.18.1 — the shared "did a satisfying event land?" matcher for the
 * Vorsorge engine.
 *
 * One reminder, one question: since the last satisfy (or the anchor when
 * never satisfied), did a reading land that fulfils this reminder's
 * cadence? Both the 15-min cron and the eventful ingest-driven worker call
 * this, so the suppression logic lives in exactly one place.
 *
 * Two satisfaction sources:
 *
 *   1. **Typed reminder** (`measurementType` non-NULL): a non-deleted
 *      `Measurement` of that type measured after the floor. BP matches on
 *      `BLOOD_PRESSURE_SYS` (the SYS sentinel) so SYS + DIA don't
 *      double-count — the validation allow-list only ever stores SYS.
 *   2. **Free-text reminder** (`measurementType` NULL): an "annual blood
 *      panel" / lab Vorsorge has no Measurement to match. v1.18.1 closes
 *      the clinical loop (gap D2): a non-deleted `LabResult` taken after
 *      the floor satisfies it. Without this a lab reminder could only ever
 *      resolve on a manual "Erledigt".
 */
import type { PrismaClient } from "@/generated/prisma/client";

/** The reminder fields the matcher reads. */
export interface ResolvableReminder {
  measurementType: import("@/generated/prisma/client").MeasurementType | null;
  anchorDate: Date | null;
  lastSatisfiedAt: Date | null;
  /**
   * v1.37.20 (#223) — the last honest skip. Part of the floor: a reading
   * OLDER than a fresh skip must not auto-resolve the cycle the user just
   * skipped. Required (not optional) so no call site can silently feed a
   * pre-skip shape and reopen the gap.
   */
  lastSkippedAt: Date | null;
  createdAt: Date;
  /**
   * Optional so the many callers that construct this shape by hand keep
   * compiling; absent means "an ordinary reminder", which is the safe reading.
   * Only `ENCOUNTER` changes the answer.
   */
  origin?: import("@/generated/prisma/client").ReminderOrigin;
}

/**
 * The floor a satisfying event must land strictly after: the later of the
 * last satisfy and the last skip, else the anchor, else the create instant.
 * A reading inside the current due cycle means the user already measured.
 *
 * v1.37.20 (#223) — the skip arm: skipping restarts the cycle at the skip
 * instant, so a reading that predates the skip belongs to the cycle the
 * user deliberately let go and must not resolve the fresh one. Without it
 * a backdated sync would silently undo the skip decision.
 */
export function satisfactionFloor(reminder: ResolvableReminder): Date {
  const cursor =
    reminder.lastSatisfiedAt !== null || reminder.lastSkippedAt !== null
      ? new Date(
          Math.max(
            reminder.lastSatisfiedAt?.getTime() ?? 0,
            reminder.lastSkippedAt?.getTime() ?? 0,
          ),
        )
      : null;
  return cursor ?? reminder.anchorDate ?? reminder.createdAt;
}

/**
 * Find the most recent satisfying event instant for a reminder, or `null`
 * when none has landed since the floor.
 *
 * A typed reminder resolves from a matching `Measurement`; a free-text
 * reminder resolves from any `LabResult` (the Lab↔Vorsorge link, D2).
 */
export async function findSatisfyingEvent(
  prisma: PrismaClient,
  userId: string,
  reminder: ResolvableReminder,
): Promise<Date | null> {
  // An appointment is not satisfied by a measurement, and refusing it here is
  // not a filter — it is the absence of a question worth asking.
  //
  // An appointment reminder is free-text by construction: there is no reading
  // that means "you went". The free-text arm below resolves from ANY lab
  // result, so without this a routine blood panel would mark next month's
  // cardiology appointment as attended and silence its nudge. Going is the only
  // thing that satisfies a visit, and that is recorded by moving the visit to
  // DONE through the encounter routes.
  if (reminder.origin === "ENCOUNTER") return null;

  const floor = satisfactionFloor(reminder);

  if (reminder.measurementType !== null) {
    const match = await prisma.measurement.findFirst({
      where: {
        userId,
        type: reminder.measurementType,
        deletedAt: null,
        measuredAt: { gt: floor },
      },
      orderBy: { measuredAt: "desc" },
      select: { measuredAt: true },
    });
    return match?.measuredAt ?? null;
  }

  // Free-text / checklist reminder → a lab panel fulfils it. Match on
  // `takenAt` (the sample instant), mirroring the measurement path's
  // `measuredAt`. Any analyte counts: a "Großes Blutbild" reminder is
  // satisfied the moment the user records any value from that panel.
  const lab = await prisma.labResult.findFirst({
    where: {
      userId,
      deletedAt: null,
      takenAt: { gt: floor },
    },
    orderBy: { takenAt: "desc" },
    select: { takenAt: true },
  });
  return lab?.takenAt ?? null;
}
