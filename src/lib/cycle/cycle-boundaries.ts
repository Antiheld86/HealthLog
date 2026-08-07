/**
 * Cycle boundary re-derivation — the inverse of what a period-start write does
 * to its neighbours.
 *
 * `POST /api/cycle/period` with `action:"start"` is not an insert. It closes
 * the previous open cycle (stamps `endDate` and `lengthDays` from the new
 * start) and, when the start is back-filled between two existing cycles, takes
 * the inserted cycle's own end from its successor. Removing that start left
 * every one of those overwrites standing: the previous cycle kept the end date
 * a cycle that no longer exists gave it, and a record whose last cycle is
 * closed has no open cycle for the engine to forecast from. The prediction
 * disappeared and there was no way to bring it back from the app.
 *
 * The repair is a re-derivation rather than an undo log, which is why it is
 * safe to run on a record whose history came from an import or a restore
 * instead of from the one-tap boundary: a cycle ends the day before the next
 * one begins, and when there is no next one it is open. That statement is true
 * of every cycle in the table regardless of how the row got there, so applying
 * it to the surviving neighbour restores exactly the state the start write
 * moved — and applying it twice changes nothing the second time.
 */
import { addDays, dayDiff } from "./day-math";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/** The Prisma client or an interactive-transaction handle. */
type CycleDb = PrismaClient | Prisma.TransactionClient;

/** The boundary columns the re-derivation moved, for the audit row. */
export interface ReanchoredCycle {
  cycleId: string;
  endDateBefore: string | null;
  endDateAfter: string | null;
  lengthDaysBefore: number | null;
  lengthDaysAfter: number | null;
}

/**
 * Re-derive the boundary of the cycle that precedes `removedStartDate` from
 * the cycles that remain. Call it AFTER the cycle at that date is soft-deleted
 * (the queries below read live rows only, so a still-live row at the removed
 * start would re-derive against itself and change nothing).
 *
 * Returns the columns it moved, or null when there is no preceding cycle or
 * the preceding cycle already holds the derived boundary — an idempotent
 * re-run must not bump `syncVersion` and make every device re-pull a row that
 * did not change.
 */
export async function reanchorAfterRemovedStart(
  db: CycleDb,
  userId: string,
  removedStartDate: string,
): Promise<ReanchoredCycle | null> {
  const prior = await db.menstrualCycle.findFirst({
    where: { userId, deletedAt: null, startDate: { lt: removedStartDate } },
    orderBy: { startDate: "desc" },
    select: { id: true, startDate: true, endDate: true, lengthDays: true },
  });
  if (!prior) return null;

  const next = await db.menstrualCycle.findFirst({
    where: { userId, deletedAt: null, startDate: { gt: removedStartDate } },
    orderBy: { startDate: "asc" },
    select: { startDate: true },
  });

  // A cycle ends the day before the next one starts; with no next one it is
  // open again, which is the state the removed start took away from it.
  const endDate = next ? addDays(next.startDate, -1) : null;
  const lengthDays = next ? dayDiff(next.startDate, prior.startDate) : null;

  if (prior.endDate === endDate && prior.lengthDays === lengthDays) return null;

  await db.menstrualCycle.update({
    where: { id: prior.id },
    data: { endDate, lengthDays, syncVersion: { increment: 1 } },
  });

  return {
    cycleId: prior.id,
    endDateBefore: prior.endDate,
    endDateAfter: endDate,
    lengthDaysBefore: prior.lengthDays,
    lengthDaysAfter: lengthDays,
  };
}
