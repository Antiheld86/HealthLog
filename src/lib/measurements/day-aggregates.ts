/**
 * Per-day aggregates of one measurement type, folded in Postgres.
 *
 * Several background readers (the status cards' graded series, the vitals
 * baseline, the tiered context, the plan review) used to `findMany` every raw
 * row in a time window and then fold them into days in JavaScript. The window
 * bounded the time span but not the row count, so an account whose watch
 * streams heart rate every few seconds materialised hundreds of thousands to
 * millions of objects per read. In the worker that was enough to exhaust the
 * heap, and the read itself outran the statement timeout.
 *
 * This reader returns at most one row per (day, segment), whatever the sample
 * density: the fold runs in SQL and only the aggregates cross the wire. `sum`,
 * `n`, `min` and `max` are exact, so every consumer that averaged, counted or
 * took extremes over the raw rows gets the same numbers from these rows.
 *
 * Days are cut in `timeZone`. `segmentStarts` optionally splits the window at
 * instants (newest first): a row's segment is the number of starts it lies
 * before, so a caller that treated "the last 21 days" and "the 70 days before
 * that" differently keeps exactly the same per-row partition.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isValidTimezone } from "@/lib/tz/format";

export interface DayAggregateRow {
  /** Calendar day in the requested zone, `YYYY-MM-DD`. */
  day: string;
  /** Segment index: 0 for rows at or after `segmentStarts[0]`, and so on. */
  segment: number;
  n: number;
  sum: number;
  min: number;
  max: number;
}

export interface ReadDayAggregatesOptions {
  userId: string;
  type: MeasurementType;
  /** Inclusive lower bound on `measuredAt`. */
  since: Date;
  /** Inclusive upper bound on `measuredAt`; omit for no upper bound. */
  until?: Date;
  /** IANA zone the day boundary is cut in. */
  timeZone: string;
  /** Rows outside `[min, max]` are dropped before the fold. */
  valueRange?: { min: number; max: number };
  /** Segment boundaries, newest first. */
  segmentStarts?: readonly Date[];
  /** Client to read through; defaults to the shared one. */
  db?: Pick<PrismaClient, "$queryRaw">;
}

export async function readDayAggregates(
  opts: ReadDayAggregatesOptions,
): Promise<DayAggregateRow[]> {
  const timeZone = isValidTimezone(opts.timeZone) ? opts.timeZone : "UTC";
  const until = opts.until
    ? Prisma.sql`AND m."measured_at" <= ${opts.until}`
    : Prisma.empty;
  const range = opts.valueRange
    ? Prisma.sql`AND m."value" >= ${opts.valueRange.min} AND m."value" <= ${opts.valueRange.max}`
    : Prisma.empty;
  const starts = opts.segmentStarts ?? [];
  const segment =
    starts.length === 0
      ? Prisma.sql`0`
      : Prisma.sql`(${Prisma.join(
          starts.map(
            (s) =>
              Prisma.sql`(CASE WHEN m."measured_at" < ${s} THEN 1 ELSE 0 END)`,
          ),
          " + ",
        )})`;

  // The day and segment are computed once per row in `src` and grouped by
  // name, so the bound zone / boundary parameters never have to match
  // themselves across SELECT and GROUP BY.
  const rows = await (opts.db ?? prisma).$queryRaw<
    Array<{
      day: string;
      segment: number;
      n: number;
      sum: number;
      min: number;
      max: number;
    }>
  >`
    WITH src AS (
      SELECT
        to_char((m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
        ${segment} AS segment,
        m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" = ${opts.type}::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${opts.since}
        ${until}
        ${range}
    )
    SELECT
      day,
      segment::int                 AS segment,
      COUNT(*)::int                AS n,
      SUM(value)::double precision AS sum,
      MIN(value)::double precision AS min,
      MAX(value)::double precision AS max
    FROM src
    GROUP BY day, segment
    ORDER BY day ASC, segment DESC
  `;
  return rows.map((r) => ({
    day: r.day,
    segment: Number(r.segment),
    n: Number(r.n),
    sum: Number(r.sum),
    min: Number(r.min),
    max: Number(r.max),
  }));
}
