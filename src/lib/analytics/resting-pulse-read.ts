/**
 * The low-percentile resting-pulse proxy, folded in Postgres.
 *
 * `deriveRestingProxyFromPulse` takes every raw `PULSE` sample of a window
 * and reduces each local day to its 20th percentile. On a watch that records
 * heart rate once a minute, a 90-day window is 130 000 samples: reading them
 * as objects, keying each one to its local day and sorting each day held the
 * event loop for over a second per request, and the route that did it runs on
 * every insights page view. The reduction needs only the day's percentile,
 * its sample count and its first instant, so it runs in SQL and one row per
 * day crosses the wire.
 *
 * Output matches `deriveRestingProxyFromPulse` exactly: `percentile_cont`
 * interpolates between the two neighbouring order statistics the same way
 * `percentile` in `strain-score.ts` does, the value is rounded the same way
 * in JavaScript, days under `RESTING_PROXY_MIN_DAILY_SAMPLES` are skipped,
 * and each day is anchored on its earliest sample. Days are cut in the zone
 * the caller passes, with the same expression `readDayAggregates` uses.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isValidTimezone } from "@/lib/tz/format";

import {
  RESTING_PROXY_DAILY_PERCENTILE,
  RESTING_PROXY_MIN_DAILY_SAMPLES,
  type PulseSample,
} from "./resting-pulse";

export async function readRestingPulseProxy(opts: {
  userId: string;
  /** Inclusive lower bound on `measuredAt`. */
  since: Date;
  /** IANA zone the day boundary is cut in. */
  timeZone: string;
  db?: Pick<PrismaClient, "$queryRaw">;
}): Promise<PulseSample[]> {
  const timeZone = isValidTimezone(opts.timeZone) ? opts.timeZone : "UTC";
  const fraction = RESTING_PROXY_DAILY_PERCENTILE / 100;
  const rows = await (opts.db ?? prisma).$queryRaw<
    Array<{ first_at: Date; p: number }>
  >(Prisma.sql`
    WITH src AS (
      SELECT
        to_char((m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
        m."measured_at" AS measured_at,
        m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" = 'PULSE'::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${opts.since}
    )
    SELECT
      MIN(measured_at) AS first_at,
      (percentile_cont(${fraction}::double precision) WITHIN GROUP (ORDER BY value))::double precision AS p
    FROM src
    GROUP BY day
    HAVING COUNT(*) >= ${RESTING_PROXY_MIN_DAILY_SAMPLES}
    ORDER BY first_at ASC
  `);
  return rows.map((r) => ({
    measuredAt: r.first_at,
    value: Math.round(Number(r.p)),
  }));
}
