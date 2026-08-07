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
import { prisma } from "@/lib/db";
import { addDays, dayDiff } from "./day-math";
import { HARD_CYCLE_MIN } from "./types";
import type {
  FlowLevel,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";

/** The Prisma client or an interactive-transaction handle. */
type CycleDb = PrismaClient | Prisma.TransactionClient;

/**
 * The boundary columns an opening write moved on the cycles around it, so the
 * audit row can name them. They are the only unrecoverable part of the write:
 * the opened cycle is a row, the re-anchoring is an overwrite of two columns
 * on somebody else's cycle history.
 */
export interface MovedAnchors {
  priorCycleId?: string;
  /** Day keys, the shape this domain stores its dates in. */
  priorEndDateBefore?: string | null;
  priorEndDateAfter?: string | null;
  priorLengthBefore?: number | null;
  priorLengthAfter?: number | null;
  openedEndDateBefore?: string | null;
  openedEndDateAfter?: string | null;
}

/**
 * Open a cycle at `date`, closing the one before it and taking the opened
 * cycle's own end from the one after it when the start is back-filled between
 * two existing cycles. Without that second half an inserted cycle keeps a null
 * endDate even though its successor's start is right there, and every history
 * surface reads a stale open cycle.
 *
 * Idempotent on `(userId, startDate)`: a re-tap on the same day, or a flow
 * entry on a day the one-tap boundary already anchored, updates the existing
 * row rather than adding a second one.
 *
 * Callers run this inside a transaction — the close-prior and open-new pair
 * must not interleave with a concurrent write, or two taps double-close a
 * prior cycle or compute a length against a stale read.
 */
export async function openCycleAt(
  db: CycleDb,
  userId: string,
  date: string,
  tz: string | null,
): Promise<{ cycleId: string; moved: MovedAnchors }> {
  const moved: MovedAnchors = {};

  // Close the prior open cycle: its end is the day before this start.
  const prior = await db.menstrualCycle.findFirst({
    where: { userId, deletedAt: null, startDate: { lt: date } },
    orderBy: { startDate: "desc" },
    select: { id: true, startDate: true, endDate: true, lengthDays: true },
  });
  if (prior) {
    moved.priorCycleId = prior.id;
    moved.priorEndDateBefore = prior.endDate;
    moved.priorEndDateAfter = addDays(date, -1);
    moved.priorLengthBefore = prior.lengthDays;
    moved.priorLengthAfter = dayDiff(date, prior.startDate);
    await db.menstrualCycle.update({
      where: { id: prior.id },
      data: {
        endDate: addDays(date, -1),
        lengthDays: dayDiff(date, prior.startDate),
        syncVersion: { increment: 1 },
      },
    });
  }

  const cycle = await db.menstrualCycle.upsert({
    where: { userId_startDate: { userId, startDate: date } },
    create: { userId, startDate: date, tz, isPredicted: false },
    update: {
      deletedAt: null,
      isPredicted: false,
      syncVersion: { increment: 1 },
    },
  });

  // Re-anchor the FOLLOWING neighbour's side of the boundary.
  const next = await db.menstrualCycle.findFirst({
    where: { userId, deletedAt: null, startDate: { gt: date } },
    orderBy: { startDate: "asc" },
    select: { startDate: true },
  });
  if (next) {
    moved.openedEndDateBefore = cycle.endDate;
    moved.openedEndDateAfter = addDays(next.startDate, -1);
    await db.menstrualCycle.update({
      where: { id: cycle.id },
      data: {
        endDate: addDays(next.startDate, -1),
        lengthDays: dayDiff(next.startDate, date),
        syncVersion: { increment: 1 },
      },
    });
  }

  return { cycleId: cycle.id, moved };
}

/**
 * Whether a logged day's bleeding is the first day of a period, and therefore
 * opens a cycle.
 *
 * Cycle rows used to come only from the one-tap period boundary. Every other
 * way of recording bleeding — the log sheet's flow chips, the bulk drain, an
 * Apple Health export of menstrual-flow samples — wrote a day-log and stopped
 * there, and the engine reads cycle rows. A person could log every period they
 * had and the module would still hold that none had happened.
 *
 * The rule is deliberately conservative, because a false cycle start corrupts
 * every length the engine derives afterwards:
 *
 *   - SPOTTING does not open a cycle. It is as often the tail of a period or
 *     its herald as its first day, and the user has an explicit chip for a
 *     real flow when it is one.
 *   - Bleeding flagged as between periods does not open a cycle. That flag
 *     exists to say exactly this.
 *   - A bleeding day within the hard physiological minimum cycle length of an
 *     existing cycle's start is part of that cycle, not a new one. This is
 *     what keeps day three of a period — or a day two somebody forgot and
 *     entered later — from starting a cycle of its own, and it needs no
 *     contiguity check to do it.
 *
 * The cost is that a genuinely short cycle (under the hard minimum) is not
 * inferred from flow alone. The one-tap start still opens one on any date, so
 * the case has an answer; guessing it from flow does not.
 */
export function bleedOpensCycle(
  flow: FlowLevel | null,
  intermenstrualBleeding: boolean,
  priorCycleStart: string | null,
  date: string,
): boolean {
  if (flow === null || flow === "NONE" || flow === "SPOTTING") return false;
  if (intermenstrualBleeding) return false;
  if (priorCycleStart === null) return true;
  return dayDiff(date, priorCycleStart) >= HARD_CYCLE_MIN;
}

/**
 * Open a cycle for a bleeding day when `bleedOpensCycle` says it starts one.
 * Returns the opened cycle's id, or null when the day changes nothing.
 *
 * Runs its own transaction so the boundary work is atomic even when the caller
 * is a plain day-log write with no transaction of its own.
 */
export async function ensureCycleForBleedingDay(
  userId: string,
  date: string,
  tz: string | null,
  day: { flow: FlowLevel | null; intermenstrualBleeding: boolean },
): Promise<string | null> {
  // Cheap pre-check before a transaction: most logged days are not a first
  // bleeding day, and the flow grade alone rules most of them out.
  if (
    day.flow === null ||
    day.flow === "NONE" ||
    day.flow === "SPOTTING" ||
    day.intermenstrualBleeding
  ) {
    return null;
  }

  return prisma.$transaction(async (db) => {
    const prior = await db.menstrualCycle.findFirst({
      where: { userId, deletedAt: null, startDate: { lte: date } },
      orderBy: { startDate: "desc" },
      select: { startDate: true },
    });
    if (
      !bleedOpensCycle(
        day.flow,
        day.intermenstrualBleeding,
        prior?.startDate ?? null,
        date,
      )
    ) {
      return null;
    }
    const { cycleId } = await openCycleAt(db, userId, date, tz);
    return cycleId;
  });
}

/**
 * Remove the cycle that opens on `date`, if there is one, and hand its span
 * back to the cycle before it. The inverse of `openCycleAt`, and the shared
 * body behind every way of taking a period start back: deleting the day-log
 * that opened it, clearing that day's flow, and deleting the cycle itself.
 *
 * Returns null when no live cycle starts on that date.
 */
export async function removeCycleStartedOn(
  db: CycleDb,
  userId: string,
  date: string,
): Promise<{ cycleId: string; reanchored: ReanchoredCycle | null } | null> {
  const opened = await db.menstrualCycle.findFirst({
    where: { userId, deletedAt: null, startDate: date },
    select: { id: true },
  });
  if (!opened) return null;

  await db.menstrualCycle.update({
    where: { id: opened.id },
    data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
  });
  return {
    cycleId: opened.id,
    reanchored: await reanchorAfterRemovedStart(db, userId, date),
  };
}

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
