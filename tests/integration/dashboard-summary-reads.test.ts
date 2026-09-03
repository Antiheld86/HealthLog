/**
 * v1.38.5 — the dashboard's two per-type reads, against a real Postgres.
 *
 * Both were rewritten for their query plans, not for their results: the
 * latest-reading read moved from `DISTINCT ON (type)` to a LATERAL join
 * over the type list, and the sparkline read gained the `type` predicate
 * its rollup key needs. Neither change may move a single row.
 *
 * So the reference implementation is the OLD SQL, kept verbatim in this
 * file and run side by side with the shipped readers over the same
 * fixture. The rows have to match exactly — value, ordering, and the
 * types that are present at all.
 *
 * The fixture deliberately carries the three cases that could break the
 * rewrite: a type whose only rows are tombstoned (must drop out of BOTH
 * results, as an inner join and a filtered group both do), a type with
 * no rows at all (same), and a rollup table holding coarser
 * granularities the DAY read must not pick up.
 *
 * Plan shape is asserted by the unit companion
 * (`src/__tests__/dashboard-summary-read-plan-guard.test.ts`) rather than
 * here: a testcontainer fixture is far too small for the planner to
 * choose the same access paths a real account produces, so an EXPLAIN
 * assertion at this size would pin nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  readLatestEver,
  readSparkBuckets,
  type LatestEverRow,
  type SparklineRow,
} from "@/lib/dashboard/summary-reads";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import type {
  MeasurementType,
  RollupGranularity,
} from "@/generated/prisma/client";

const SPARK_DAYS = 7;
const TYPES = [...measurementTypeEnum.options] as MeasurementType[];

/** The pre-v1.38.5 latest-reading read, kept as the parity reference. */
function legacyLatestEver(userId: string): Promise<LatestEverRow[]> {
  return getPrismaClient().$queryRaw<LatestEverRow[]>`
    SELECT DISTINCT ON (m."type")
      m."type"                                  AS type,
      m."value"::double precision               AS value,
      m."measured_at"                           AS measured_at
    FROM measurements m
    WHERE m."user_id" = ${userId}
      AND m."deleted_at" IS NULL
    ORDER BY m."type", m."measured_at" DESC
  `;
}

/** The pre-v1.38.5 sparkline read, without the `type` predicate. */
function legacySparkBuckets(userId: string): Promise<SparklineRow[]> {
  return getPrismaClient().$queryRaw<SparklineRow[]>`
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
        AND r."granularity" = 'DAY'
    ) sub
    WHERE rn <= ${SPARK_DAYS}
    ORDER BY type, bucket_start ASC
  `;
}

const DAY = 86_400_000;

async function seedAccount(): Promise<string> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "summary-reads-user",
      email: "summary-reads-user@example.test",
      role: "USER",
    },
  });

  // Live readings across several types, several rows each, so the
  // "latest wins" pick has something to choose between.
  const live: MeasurementType[] = [
    "WEIGHT",
    "PULSE",
    "BLOOD_PRESSURE_SYS",
    "ACTIVITY_STEPS",
    "SLEEP_DURATION",
  ];
  const base = Date.UTC(2026, 0, 1);
  const rows = live.flatMap((type, ti) =>
    Array.from({ length: 12 }, (_, i) => ({
      userId: user.id,
      type,
      value: 50 + ti * 10 + i,
      unit: "x",
      source: "MANUAL" as const,
      measuredAt: new Date(base + i * DAY + ti * 3_600_000),
      deletedAt: null as Date | null,
    })),
  );
  // BODY_FAT exists only as tombstones: both reads must drop it.
  rows.push(
    ...Array.from({ length: 4 }, (_, i) => ({
      userId: user.id,
      type: "BODY_FAT" as MeasurementType,
      value: 20 + i,
      unit: "%",
      source: "MANUAL" as const,
      measuredAt: new Date(base + i * DAY + 7_200_000),
      deletedAt: new Date(base + 30 * DAY),
    })),
  );
  // A live type whose newest row is tombstoned — the read must fall back
  // to the newest surviving row, not report the deleted one.
  rows.push(
    {
      userId: user.id,
      type: "BLOOD_GLUCOSE" as MeasurementType,
      value: 95,
      unit: "mg/dL",
      source: "MANUAL" as const,
      measuredAt: new Date(base + 5 * DAY),
      deletedAt: null,
    },
    {
      userId: user.id,
      type: "BLOOD_GLUCOSE" as MeasurementType,
      value: 999,
      unit: "mg/dL",
      source: "MANUAL" as const,
      measuredAt: new Date(base + 9 * DAY),
      deletedAt: new Date(base + 30 * DAY),
    },
  );
  await prisma.measurement.createMany({ data: rows });

  // DAY buckets past the SPARK_DAYS window, plus coarser granularities
  // the DAY read must ignore.
  const bucketRows = live.flatMap((type, ti) =>
    Array.from({ length: 11 }, (_, i) => ({
      userId: user.id,
      type,
      granularity: "DAY" as RollupGranularity,
      bucketStart: new Date(base + i * DAY),
      source: "MANUAL" as const,
      count: 3,
      mean: 60 + ti + i,
      minValue: 50,
      maxValue: 70,
      sumValue: 180 + ti,
    })),
  );
  bucketRows.push(
    ...(["WEEK", "MONTH", "YEAR"] as const).flatMap((granularity) =>
      live.map((type, ti) => ({
        userId: user.id,
        type,
        granularity,
        bucketStart: new Date(base + ti * DAY),
        source: "MANUAL" as const,
        count: 9,
        mean: 1000 + ti,
        minValue: 900,
        maxValue: 1100,
        sumValue: 9000 + ti,
      })),
    ),
  );
  await prisma.measurementRollup.createMany({ data: bucketRows });

  return user.id;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("dashboard summary reads — parity with the pre-v1.38.5 SQL", () => {
  it("returns the identical latest-reading rows the DISTINCT ON returned", async () => {
    const userId = await seedAccount();

    const [legacy, shipped] = await Promise.all([
      legacyLatestEver(userId),
      readLatestEver(getPrismaClient(), userId, TYPES),
    ]);

    expect(shipped).toEqual(legacy);
    // Not a vacuous pass: the fixture has to have produced rows.
    expect(shipped.length).toBe(6);
    // Tombstone-only type is absent from both; a type with no rows too.
    expect(shipped.map((r) => r.type)).not.toContain("BODY_FAT");
    expect(shipped.map((r) => r.type)).not.toContain("VO2_MAX");
    // The newest LIVE glucose row wins, not the newer tombstoned one.
    expect(shipped.find((r) => r.type === "BLOOD_GLUCOSE")?.value).toBe(95);
  });

  it("returns the identical sparkline buckets the type-less read returned", async () => {
    const userId = await seedAccount();

    const [legacy, shipped] = await Promise.all([
      legacySparkBuckets(userId),
      readSparkBuckets(getPrismaClient(), userId, TYPES, SPARK_DAYS),
    ]);

    expect(shipped).toEqual(legacy);
    // Five types × the trailing SPARK_DAYS buckets, and nothing coarser.
    expect(shipped.length).toBe(5 * SPARK_DAYS);
    expect(shipped.every((r) => r.mean < 1000)).toBe(true);
  });

  it("orders both reads the way the callers' per-type maps expect", async () => {
    const userId = await seedAccount();

    const latest = await readLatestEver(getPrismaClient(), userId, TYPES);
    // Enum declaration order, exactly as `ORDER BY m."type"` produced it.
    const enumRank = new Map(TYPES.map((t, i) => [t, i]));
    const ranks = latest.map((r) => enumRank.get(r.type) ?? -1);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    const spark = await readSparkBuckets(
      getPrismaClient(),
      userId,
      TYPES,
      SPARK_DAYS,
    );
    for (const type of new Set(spark.map((r) => r.type))) {
      const stamps = spark
        .filter((r) => r.type === type)
        .map((r) => r.bucket_start.getTime());
      expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    }
  });
});
