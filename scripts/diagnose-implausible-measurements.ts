/**
 * Read-only diagnostic for stored measurement rows outside the app's own
 * declared plausibility domain.
 *
 * `VALUE_RANGES` in `@/lib/validations/measurement` is the band the
 * application says a metric can occupy. Every path a person can drive has
 * always enforced it; the provider sync writers did not, so rows the
 * application itself calls impossible reached the table — and every mean,
 * median and personal band built from them inherited the impossibility. The
 * writers enforce it now, which stops new rows landing. It says nothing about
 * the rows already there.
 *
 * This reports them and repairs nothing. What to do with a stored impossible
 * row is a judgement the data cannot make: a pulse of 55 million is plainly a
 * decode slip and a candidate for deletion, while a weight of 0.9 kg might be
 * a neonatal record on a shared scale, or a unit mix-up, or a real reading the
 * band is simply too narrow for. Deleting somebody's health record on a
 * heuristic is not a thing a script gets to decide.
 *
 * Output is aggregate: one line per (metric, source) bucket with the row
 * count, the number of distinct records affected, the observed extremes, and
 * the window they fall in. Individual readings are not printed — the bucket
 * plus the metric's own declared bound is what a decision needs, and a log
 * file full of somebody's vitals is not.
 *
 * Run (inside the app container, which has DATABASE_URL):
 *   pnpm dlx tsx scripts/diagnose-implausible-measurements.ts
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import { VALUE_RANGES } from "@/lib/validations/measurement";

interface BucketRow {
  type: string;
  source: string;
  row_count: bigint;
  record_count: bigint;
  min_value: number;
  max_value: number;
  first_at: Date;
  last_at: Date;
  tombstoned: bigint;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const types = Object.keys(VALUE_RANGES).sort();
  const mins = types.map((t) => VALUE_RANGES[t]!.min);
  const maxes = types.map((t) => VALUE_RANGES[t]!.max);

  // The band table rides in as three parallel bound arrays rather than a
  // spliced VALUES list, so the query carries no interpolated text at all.
  // `value <> value` is the NaN probe: a double-precision column can hold one,
  // and it compares false against every bound including itself.
  const buckets = await prisma.$queryRaw<BucketRow[]>`
    WITH bands(type, min_value, max_value) AS (
      SELECT * FROM unnest(
        ${types}::text[],
        ${mins}::double precision[],
        ${maxes}::double precision[]
      )
    )
    SELECT
      m."type"::text                                        AS type,
      m."source"::text                                      AS source,
      COUNT(*)::bigint                                      AS row_count,
      COUNT(DISTINCT m."user_id")::bigint                   AS record_count,
      MIN(m."value")                                        AS min_value,
      MAX(m."value")                                        AS max_value,
      MIN(m."measured_at")                                  AS first_at,
      MAX(m."measured_at")                                  AS last_at,
      COUNT(*) FILTER (WHERE m."deleted_at" IS NOT NULL)::bigint AS tombstoned
    FROM "measurements" m
    JOIN bands b ON b."type" = m."type"::text
    WHERE m."value" < b.min_value
       OR m."value" > b.max_value
       OR m."value" <> m."value"
    GROUP BY m."type", m."source"
    ORDER BY COUNT(*) DESC, m."type"::text ASC, m."source"::text ASC
  `;

  if (buckets.length === 0) {
    console.log(
      `Every stored measurement sits inside its metric's declared range ` +
        `(${types.length} metric bands checked). Nothing to review.`,
    );
    return;
  }

  const totalRows = buckets.reduce((sum, b) => sum + Number(b.row_count), 0);
  const affectedTypes = new Set(buckets.map((b) => b.type));
  const affectedSources = new Set(buckets.map((b) => b.source));

  console.log(
    `${totalRows} stored row(s) sit outside the declared plausibility band, ` +
      `across ${affectedTypes.size} metric(s) and ${affectedSources.size} source(s).\n` +
      `Nothing below is modified. Each line is a (metric, source) bucket; the ` +
      `band is the metric's own declared domain.\n`,
  );

  // Group by metric so the declared band is stated once per heading, and rank
  // the metrics by how much of the problem each one is. The query's own
  // ordering already ranks the sources inside a metric.
  const byType = new Map<string, BucketRow[]>();
  for (const bucket of buckets) {
    const bucketsForType = byType.get(bucket.type);
    if (bucketsForType) bucketsForType.push(bucket);
    else byType.set(bucket.type, [bucket]);
  }
  const ranked = [...byType.entries()].sort(
    (a, b) =>
      b[1].reduce((sum, x) => sum + Number(x.row_count), 0) -
      a[1].reduce((sum, x) => sum + Number(x.row_count), 0),
  );

  for (const [type, rows] of ranked) {
    const band = VALUE_RANGES[type]!;
    console.log(`${type} — declared band ${band.min}…${band.max}`);
    for (const bucket of rows) {
      const live = Number(bucket.row_count) - Number(bucket.tombstoned);
      console.log(
        `  ${bucket.source.padEnd(14)} ` +
          `${String(bucket.row_count).padStart(7)} row(s) ` +
          `(${live} live, ${bucket.tombstoned} tombstoned) ` +
          `across ${bucket.record_count} record(s) — ` +
          `observed ${bucket.min_value}…${bucket.max_value}, ` +
          `${ymd(bucket.first_at)} → ${ymd(bucket.last_at)}`,
      );
    }
  }

  console.log(
    `\nThe sync writers refuse these values now, so the population above is ` +
      `closed unless a writer without the gate is still in play. Removing a ` +
      `row is a maintainer decision, per bucket.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
