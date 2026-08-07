/**
 * Read-only diagnostic for hand-entered sleep rows stored in the wrong unit.
 *
 * `SLEEP_DURATION` is stored in minutes. The manual entry field asked for
 * hours and sent the typed number through unconverted, so a night entered as
 * 7.5 was filed as seven and a half MINUTES. Nothing objected: a single sleep
 * STAGE really can be that short, so the value sits inside the column's
 * plausibility band and looks like an ordinary row.
 *
 * That ambiguity is why this reports and does not repair. A stage segment of
 * eight minutes and a night typed as eight hours are the same number in the
 * same column, and only the person who entered it knows which it was. What CAN
 * be narrowed is the population: a MANUAL, whole-night row (no sleep stage) is
 * one somebody typed into the field, and a typed night shorter than the
 * longest plausible hours entry is almost certainly hours that were read as
 * minutes.
 *
 * The output lists the candidates with their date, stored value and the night
 * they would have been if the number was hours, so the maintainer can decide
 * per row. Nothing is written.
 *
 * Run (inside the app container, which has DATABASE_URL):
 *   pnpm dlx tsx scripts/diagnose-manual-sleep-hours.ts
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import { MINUTES_PER_HOUR } from "@/lib/measurements/entry-units";

/**
 * Longest night anybody types into an hours field. A stored value at or below
 * this reads as hours; above it, the number can only ever have been minutes.
 */
const MAX_PLAUSIBLE_HOURS = 24;

async function main(): Promise<void> {
  const suspects = await prisma.measurement.findMany({
    where: {
      type: "SLEEP_DURATION",
      source: "MANUAL",
      deletedAt: null,
      // Whole-night rows only — a staged row comes from a sync source, never
      // from the entry field.
      sleepStage: null,
      value: { gt: 0, lte: MAX_PLAUSIBLE_HOURS },
    },
    orderBy: [{ userId: "asc" }, { measuredAt: "asc" }],
    select: {
      id: true,
      userId: true,
      value: true,
      measuredAt: true,
      createdAt: true,
    },
  });

  if (suspects.length === 0) {
    console.log(
      "No hand-entered sleep rows in the hours-shaped band. Nothing to review.",
    );
    return;
  }

  const byUser = new Map<string, typeof suspects>();
  for (const row of suspects) {
    const bucket = byUser.get(row.userId);
    if (bucket) bucket.push(row);
    else byUser.set(row.userId, [row]);
  }

  console.log(
    `${suspects.length} hand-entered sleep row(s) across ${byUser.size} record(s) ` +
      `store a value of ${MAX_PLAUSIBLE_HOURS} or less.\n` +
      `Each is either a very short recorded sleep, or hours that were read as minutes.\n`,
  );

  for (const [userId, rows] of byUser) {
    console.log(`record ${userId} — ${rows.length} row(s)`);
    for (const row of rows) {
      const asHours = row.value * MINUTES_PER_HOUR;
      console.log(
        `  ${row.measuredAt.toISOString().slice(0, 10)}  id=${row.id}  ` +
          `stored=${row.value} min  if it was hours=${asHours} min ` +
          `(${(asHours / MINUTES_PER_HOUR).toFixed(2)} h)  ` +
          `entered=${row.createdAt.toISOString().slice(0, 10)}`,
      );
    }
    console.log("");
  }

  console.log(
    "Nothing was changed. Correct a row from the record list, or delete and re-enter it.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
