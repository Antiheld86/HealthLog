/**
 * In-memory stand-in for `readDayAggregates`, for unit tests that mock
 * `@/lib/db`.
 *
 * It reads the rows through the mocked `prisma.measurement.findMany` (so a
 * test's existing row fixture keeps feeding the reader) and folds them with
 * the same day / segment / range rules the SQL applies. The integration test
 * `tests/integration/dense-read-bounded.test.ts` pins that this fold and the
 * SQL agree on real Postgres.
 */
import { prisma } from "@/lib/db";
import type {
  DayAggregateRow,
  ReadDayAggregatesOptions,
} from "@/lib/measurements/day-aggregates";
import { userDayKey } from "@/lib/tz/format";

export function foldDayAggregates(
  rows: ReadonlyArray<{ measuredAt: Date; value: number }>,
  opts: Omit<ReadDayAggregatesOptions, "userId" | "type">,
): DayAggregateRow[] {
  const starts = opts.segmentStarts ?? [];
  const byKey = new Map<string, DayAggregateRow>();
  for (const r of rows) {
    const t = r.measuredAt.getTime();
    if (t < opts.since.getTime()) continue;
    if (opts.until && t > opts.until.getTime()) continue;
    if (
      opts.valueRange &&
      (r.value < opts.valueRange.min || r.value > opts.valueRange.max)
    ) {
      continue;
    }
    const day = userDayKey(r.measuredAt, opts.timeZone);
    const segment = starts.filter((s) => t < s.getTime()).length;
    const key = `${day}|${segment}`;
    const acc = byKey.get(key);
    if (acc) {
      acc.n += 1;
      acc.sum += r.value;
      if (r.value < acc.min) acc.min = r.value;
      if (r.value > acc.max) acc.max = r.value;
    } else {
      byKey.set(key, {
        day,
        segment,
        n: 1,
        sum: r.value,
        min: r.value,
        max: r.value,
      });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : b.segment - a.segment,
  );
}

export async function fakeReadDayAggregates(
  opts: ReadDayAggregatesOptions,
): Promise<DayAggregateRow[]> {
  const rows = ((await prisma.measurement.findMany({
    where: {
      userId: opts.userId,
      type: opts.type,
      deletedAt: null,
      measuredAt: { gte: opts.since, ...(opts.until && { lte: opts.until }) },
    },
    orderBy: { measuredAt: "asc" },
    select: { measuredAt: true, value: true },
  })) ?? []) as Array<{ measuredAt: Date; value: number }>;
  return foldDayAggregates(rows, opts);
}
