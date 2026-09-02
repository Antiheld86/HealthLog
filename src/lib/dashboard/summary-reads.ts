/**
 * The two per-type reads behind the dashboard summary's metric tiles.
 *
 * Both used to live inline in `src/app/api/dashboard/summary/route.ts`.
 * They are lifted out for the same reason `buildMedsTodayBlock` is: the
 * SQL is the contract, and a contract that only exists inside a route
 * handler cannot be exercised against a real Postgres. The integration
 * suite runs THESE functions, not a transcription of them.
 *
 * Both reads are shaped by one property of the schema: PostgreSQL 16 has
 * no index skip scan. An index on `(user_id, type, …)` cannot hand back
 * "one row per type" on its own — something has to supply the type list.
 * So both queries name it. `measurementTypes` is the complete canonical
 * enum, so naming it filters nothing out; it exists to give the planner
 * an equality on the leading type column, which turns a full pass over
 * the account into one bounded lookup per type.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { MeasurementType } from "@/generated/prisma/client";

/** v1.4.38 W-F — the single most recent reading per measurement
 *  type, irrespective of age. One row per metric the user has ever
 *  touched; replaces the legacy unbounded `prisma.measurement.findMany`.
 *
 *  REG-11 (v1.4.44): dropped the trailing-7-day window from the WHERE
 *  clause. The old shape returned `latestValue: null` + an empty
 *  sparkline for accounts whose last BP / pulse reading was older than
 *  7 days, leaving the iOS tile blank even though the historical row
 *  was still in the database. The all-time aggregate (`groupBy` on
 *  `measurements`) already proves the row exists; the row count is
 *  still bounded by `|measurementTypes|`, now because the query is
 *  driven FROM that list (v1.38.5) rather than grouped down to it. */
export interface LatestEverRow {
  type: MeasurementType;
  value: number;
  measured_at: Date;
}

/** v1.4.38 W-F — per-day measurement_rollup bucket feeding the dashboard
 *  sparkline. At most `sparkDays` buckets per metric × N metrics —
 *  bounded by `sparkDays * |measurementTypes|` rather than the raw row
 *  count.
 *
 *  v1.4.39 W-SUM — `sum_value` rides along so the cumulative tile
 *  (ACTIVITY_STEPS) renders the daily SUM rather than the per-bucket
 *  MEAN. Spot metrics ignore the column; cumulative tiles fall back to
 *  `mean * count` when the legacy NULL hits (boot-backfill convergence
 *  window).
 *
 *  REG-11 (v1.4.44): switched from a calendar-window filter
 *  (`bucket_start >= sevenDaysAgo`) to a `ROW_NUMBER() OVER (PARTITION
 *  BY type ORDER BY bucket_start DESC)` window so the sparkline takes
 *  the last `sparkDays` daily buckets per type regardless of age. An
 *  account whose last BP reading is 60 days old now still gets the
 *  trailing 7 days of historical buckets feeding the tile chart. */
export interface SparklineRow {
  type: MeasurementType;
  bucket_start: Date;
  mean: number;
  count: number;
  sum_value: number | null;
}

/**
 * Latest live reading per measurement type.
 *
 * v1.38.5 — a LATERAL join over the type list, replacing the
 * `DISTINCT ON (m."type")` this read used to be.
 *
 * The DISTINCT-ON shape has to produce every live row of the account in
 * `(type, measured_at DESC)` order before it can throw all but the first
 * of each group away. With no skip scan there is no index that hands it
 * one row per type, so on a multi-year account it degrades to a
 * sequential scan plus an in-memory sort that spills to disk once it
 * outgrows `work_mem`.
 *
 * Driving the read from the type list instead makes it one index lookup
 * per type against `measurements_live_covering_idx` (the partial
 * `(user_id, type, measured_at DESC) WHERE deleted_at IS NULL` index from
 * migration 0183), each stopping at the first row. `CROSS JOIN LATERAL`
 * is an inner join, so a type with no live reading drops out exactly as
 * DISTINCT ON dropped it, and `ORDER BY mt."type"` reproduces the enum
 * ordering the old `ORDER BY m."type"` emitted. Same rows, same order.
 *
 * The driving relation is aliased `mt`, not `t`: a one-letter `t` alias
 * makes `t("type")` in the SQL text look exactly like a `t()` translation
 * call to the i18n call-site scanner, which then reports a missing key.
 */
export function readLatestEver(
  db: PrismaClient,
  userId: string,
  measurementTypes: readonly MeasurementType[],
): Promise<LatestEverRow[]> {
  return db.$queryRaw<LatestEverRow[]>`
    SELECT
      mt."type"                                  AS type,
      l."value"                                 AS value,
      l."measured_at"                           AS measured_at
    FROM unnest(${[...measurementTypes]}::"measurement_type"[]) AS mt("type")
    CROSS JOIN LATERAL (
      SELECT
        m."value"::double precision             AS value,
        m."measured_at"                         AS measured_at
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."type" = mt."type"
        AND m."deleted_at" IS NULL
      ORDER BY m."measured_at" DESC
      LIMIT 1
    ) l
    ORDER BY mt."type"
  `;
}

/**
 * Trailing `sparkDays` DAY rollup buckets per measurement type.
 *
 * v1.38.5 — the `type` predicate is what makes this read indexable.
 *
 * `measurement_rollups` is keyed `(user_id, type, granularity,
 * bucket_start, source)`. Filtering on `user_id` and `granularity` alone
 * skips the second key column, so on a single-account host — where
 * `user_id` selects nearly the whole table — neither the primary key nor
 * `measurement_rollups_user_type_granularity_bucket_desc_idx` can drive
 * the read, and Postgres falls back to a sequential scan over every
 * granularity the account has ever rolled up.
 *
 * Naming the full enum restores the equality on `type` and the read
 * becomes a bitmap index scan over the DAY slice. Deliberately NOT
 * narrowed to the types the metric cards happen to render: the full enum
 * keeps the returned row set provably identical to the unfiltered read,
 * and a new measurement type stays included by construction.
 */
export function readSparkBuckets(
  db: PrismaClient,
  userId: string,
  measurementTypes: readonly MeasurementType[],
  sparkDays: number,
): Promise<SparklineRow[]> {
  return db.$queryRaw<SparklineRow[]>`
    SELECT type, bucket_start, mean, count, sum_value
    FROM (
      SELECT
        r."type"                                  AS type,
        r."bucket_start"                          AS bucket_start,
        r."mean"::double precision                AS mean,
        r."count"::int                            AS count,
        r."sum_value"::double precision           AS sum_value,
        ROW_NUMBER() OVER (
          PARTITION BY r."type"
          ORDER BY r."bucket_start" DESC
        ) AS rn
      FROM measurement_rollups r
      WHERE r."user_id" = ${userId}
        AND r."type" = ANY(${[...measurementTypes]}::"measurement_type"[])
        AND r."granularity" = 'DAY'
    ) sub
    WHERE rn <= ${sparkDays}
    ORDER BY type, bucket_start ASC
  `;
}
