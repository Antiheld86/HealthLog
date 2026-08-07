/**
 * Read-only diagnostic for cycle records the module has stopped reading.
 *
 * Two defects put records into states that look, from the app, like no periods
 * were ever logged. Both are fixed going forward; neither repairs the rows it
 * already made, and neither is visible from the surface it broke.
 *
 * The first is a closed torso. Logging a period start closes the cycle before
 * it, and removing that start used to leave the closure standing. The previous
 * cycle keeps an end date that a cycle which no longer exists gave it, and a
 * record whose last cycle is closed has no open cycle for the engine to
 * forecast from, so the prediction disappears and does not come back. The
 * signature is exact and needs no audit trail: a live cycle carrying an end
 * date with no live cycle after it. A cycle is closed by its successor, so
 * closed with no successor means the successor is gone.
 *
 * The second is a period that only ever existed as flow. Cycle rows used to be
 * written by the one-tap period boundary alone, so bleeding entered through the
 * log sheet's chips, the bulk drain or an Apple Health import produced day-logs
 * and no cycle at all. The engine reads cycle rows, so the record holds periods
 * and reports none.
 *
 * The bleeding-day rule below is imported from the write path rather than
 * restated, so this report and the app cannot drift on what counts as a period
 * start.
 *
 * Nothing is written. The output is a per-record inventory plus the two flags,
 * so the state can be read before anything is decided about it.
 *
 * Run (inside the app container, which has DATABASE_URL):
 *   pnpm dlx tsx scripts/diagnose-cycle-state.ts
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import { bleedOpensCycle } from "@/lib/cycle/cycle-boundaries";
import { dayDiff } from "@/lib/cycle/day-math";

/** Below this many observed cycles the app withholds its phase band. */
const STILL_LEARNING_BELOW = 3;

interface CycleRow {
  id: string;
  startDate: string;
  endDate: string | null;
  lengthDays: number | null;
  periodEndDate: string | null;
  deletedAt: Date | null;
  isPredicted: boolean;
}

interface DayRow {
  date: string;
  flow: string | null;
  intermenstrualBleeding: boolean;
}

function describeCycle(c: CycleRow): string {
  const state = c.deletedAt
    ? `deleted ${c.deletedAt.toISOString().slice(0, 10)}`
    : c.endDate
      ? `closed ${c.endDate}`
      : "open";
  const length = c.lengthDays === null ? "-" : `${c.lengthDays}d`;
  const period = c.periodEndDate ? ` periodEnd=${c.periodEndDate}` : "";
  const predicted = c.isPredicted ? " PREDICTED" : "";
  return `${c.startDate}  ${state.padEnd(20)} length=${length.padEnd(5)}${period}${predicted}`;
}

async function main(): Promise<void> {
  // Every record that has ever touched the module, from either side: a cycle
  // row, or a day-log. A record with day-logs and no cycles is precisely one
  // of the cases this exists to find, so it cannot be found by cycles alone.
  const [cycleOwners, dayOwners] = await Promise.all([
    prisma.menstrualCycle.findMany({
      distinct: ["userId"],
      select: { userId: true },
    }),
    prisma.cycleDayLog.findMany({
      distinct: ["userId"],
      select: { userId: true },
    }),
  ]);
  const userIds = Array.from(
    new Set([
      ...cycleOwners.map((r) => r.userId),
      ...dayOwners.map((r) => r.userId),
    ]),
  ).sort();

  if (userIds.length === 0) {
    console.log("No cycle records on this instance. Nothing to report.");
    return;
  }

  let torsoTotal = 0;
  let flowOnlyTotal = 0;
  let staleBoundaryTotal = 0;

  for (const userId of userIds) {
    const [cycles, days] = await Promise.all([
      prisma.menstrualCycle.findMany({
        where: { userId },
        orderBy: { startDate: "asc" },
        select: {
          id: true,
          startDate: true,
          endDate: true,
          lengthDays: true,
          periodEndDate: true,
          deletedAt: true,
          isPredicted: true,
        },
      }) as Promise<CycleRow[]>,
      prisma.cycleDayLog.findMany({
        where: { userId, deletedAt: null },
        orderBy: { date: "asc" },
        select: { date: true, flow: true, intermenstrualBleeding: true },
      }) as Promise<DayRow[]>,
    ]);

    const live = cycles.filter((c) => c.deletedAt === null);
    const liveStarts = live.map((c) => c.startDate);
    const startSet = new Set(liveStarts);

    console.log(`record ${userId}`);
    console.log(
      `  ${cycles.length} cycle row(s), ${live.length} live, ` +
        `${days.length} day-log(s)`,
    );
    for (const c of cycles) console.log(`    ${describeCycle(c)}`);

    // A closed cycle with nothing after it: closed by a start that is gone.
    const torsos = live.filter(
      (c, i) => c.endDate !== null && i === live.length - 1,
    );
    // A closed cycle whose boundary does not match the successor it has.
    const stale = live.filter((c, i) => {
      const next = live[i + 1];
      if (!next) return false;
      const expectedLength = dayDiff(next.startDate, c.startDate);
      return c.endDate === null || c.lengthDays !== expectedLength;
    });

    // Bleeding days the write path would treat as a period start today, on a
    // date carrying no live cycle. Walked forward so each decision sees the
    // starts that already exist plus the ones this pass would infer, exactly
    // as a replay of the writes would.
    const inferred: string[] = [...liveStarts].sort();
    const flowOnly: string[] = [];
    for (const d of days) {
      if (startSet.has(d.date)) continue;
      const prior = inferred.filter((s) => s <= d.date).at(-1) ?? null;
      if (
        bleedOpensCycle(
          d.flow as never,
          d.intermenstrualBleeding,
          prior,
          d.date,
        )
      ) {
        flowOnly.push(d.date);
        inferred.push(d.date);
        inferred.sort();
      }
    }

    if (torsos.length > 0) {
      torsoTotal += torsos.length;
      console.log(
        `  CLOSED TORSO: ${torsos
          .map((c) => `${c.startDate} (ends ${c.endDate})`)
          .join(", ")}`,
      );
      console.log(
        "    The last cycle is closed and has no successor, so the engine has " +
          "no open cycle to forecast from. Re-opening it means clearing its " +
          "endDate and lengthDays.",
      );
    }
    if (stale.length > 0) {
      staleBoundaryTotal += stale.length;
      console.log(
        `  STALE BOUNDARY: ${stale.map((c) => c.startDate).join(", ")}`,
      );
      console.log(
        "    The stored end or length disagrees with the next cycle's start.",
      );
    }
    if (flowOnly.length > 0) {
      flowOnlyTotal += flowOnly.length;
      console.log(`  PERIOD WITH NO CYCLE ROW: ${flowOnly.join(", ")}`);
      console.log(
        "    Bleeding was logged on these days and no cycle opens on them. " +
          "Re-saving each day through the log sheet opens it now.",
      );
    }
    if (live.length > 0 && live.length - 1 < STILL_LEARNING_BELOW) {
      console.log(
        `  Only ${live.length - 1} observed cycle length(s): under the ` +
          `${STILL_LEARNING_BELOW}-cycle gate, so the phase band stays withheld.`,
      );
    }
    console.log("");
  }

  console.log(
    `${userIds.length} record(s) inspected. ` +
      `${torsoTotal} closed torso(s), ${staleBoundaryTotal} stale boundary(ies), ` +
      `${flowOnlyTotal} logged period(s) with no cycle row.`,
  );
  console.log("Nothing was changed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
