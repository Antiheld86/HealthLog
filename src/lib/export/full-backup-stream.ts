/**
 * The full-backup payload, written out incrementally instead of built.
 *
 * Why it exists. `buildFullBackupJson` has to hold two things at once that
 * both scale with the record: the payload object graph, and the JSON string
 * `JSON.stringify` makes of it. On a seeded account of 445 000 measurements,
 * 30 000 mood entries and 60 000 intake events, that pair alone exhausts a
 * 546 MB heap and the process dies with `Reached heap limit` — measured, not
 * inferred, and reproducible with `--max-old-space-size=450`. The production
 * container is capped at 1 GB, which puts V8's limit at 524 MB, so the weekly
 * pass took the whole app down with it: every other user of that instance lost
 * their session because one account's backup did not fit.
 *
 * What changed. The three tables that scale with a long-lived record —
 * measurements, intake events, mood entries — are declared rather than read
 * (`deferBulk`), and this writer pulls them through page by page, serialising
 * one row at a time straight into the sink. Every other section is stringified
 * and then RELEASED from the payload before the next one is touched, so the
 * peak is the largest single section rather than the sum of all of them.
 *
 * The output is byte-identical to `JSON.stringify(payload)`. That is not a
 * hope: `Object.entries` walks a plain object in insertion order, which is the
 * order `JSON.stringify` uses, and `JSON.stringify([a, b])` is exactly
 * `"[" + JSON.stringify(a) + "," + JSON.stringify(b) + "]"` for plain rows.
 * The integration suite pins it against the materialising builder rather than
 * trusting that paragraph.
 */
import v8 from "node:v8";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  buildFullBackupPayload,
  isDeferredRows,
  type FullBackupCounts,
  type FullBackupOptions,
} from "@/lib/export/full-backup-payload";

/** Where the writer puts its pieces. Awaited, so a sink can apply backpressure. */
export type BackupJsonSink = (chunk: string) => void | Promise<void>;

/**
 * How much serialised JSON to gather before handing it to the sink.
 *
 * Row-at-a-time writes would push half a million tiny strings through gzip and
 * spend more time in framing than in compression; a batch this size keeps the
 * resident buffer trivial and the write count in the low thousands.
 */
const FLUSH_BYTES = 256 * 1024;

/**
 * Fraction of V8's heap limit the writer refuses to cross.
 *
 * The point is not to make an oversized account succeed — it is to make it
 * FAIL AS A JOB. A backup that runs out of heap takes the process with it, and
 * a pg-boss worker sharing the app process means one account's record can
 * restart the instance for everybody. Because the work is now incremental
 * there is a checkpoint every few hundred kilobytes, so the guard actually
 * gets to run before V8 hits the wall; the old single `JSON.stringify` had no
 * point at which anything could intervene.
 */
const HEAP_HIGH_WATER = 0.8;

/** Thrown when the writer stops itself short of the heap limit. */
export class BackupHeapBudgetExceededError extends Error {
  constructor(usedBytes: number, ceilingBytes: number) {
    super(
      `Backup aborted at ${Math.round(usedBytes / 1024 / 1024)} MB of heap ` +
        `(budget ${Math.round(ceilingBytes / 1024 / 1024)} MB). The record is ` +
        `too large for this container's memory limit; raise the container's ` +
        `memory or NODE_OPTIONS=--max-old-space-size.`,
    );
    this.name = "BackupHeapBudgetExceededError";
  }
}

export interface StreamFullBackupOptions extends FullBackupOptions {
  /**
   * Heap ceiling in bytes. Defaults to 80 % of V8's limit for this process.
   * Tests pass an explicit value; nothing else should need to.
   */
  heapCeilingBytes?: number;
}

function defaultHeapCeiling(): number {
  return Math.floor(v8.getHeapStatistics().heap_size_limit * HEAP_HIGH_WATER);
}

/**
 * Write the full-backup JSON for `userId` into `sink`, and answer the counts.
 *
 * The counts for the three deferred tables are filled in as their rows go
 * past, so a caller gets the same numbers the materialising builder reports.
 */
export async function streamFullBackupJson(
  prisma: PrismaClient,
  userId: string,
  sink: BackupJsonSink,
  options: StreamFullBackupOptions = {},
): Promise<FullBackupCounts> {
  const ceiling = options.heapCeilingBytes ?? defaultHeapCeiling();
  const { payload, counts } = await buildFullBackupPayload(prisma, userId, {
    ...options,
    deferBulk: true,
  });

  let pending = "";
  let pendingBytes = 0;

  const flush = async (force: boolean): Promise<void> => {
    if (pending === "" || (!force && pendingBytes < FLUSH_BYTES)) return;
    const chunk = pending;
    pending = "";
    pendingBytes = 0;
    await sink(chunk);
    const used = process.memoryUsage().heapUsed;
    if (used > ceiling) throw new BackupHeapBudgetExceededError(used, ceiling);
  };

  const write = async (piece: string): Promise<void> => {
    pending += piece;
    pendingBytes += piece.length;
    await flush(false);
  };

  const bulkCounts: Record<string, number> = {};

  await write("{");
  let first = true;
  // The walk is destructive: each section is released from the payload as soon
  // as its JSON is in the sink, which is what keeps the peak at one section
  // rather than at all of them. Nothing else reads this object.
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    // `JSON.stringify` omits an undefined-valued key; so does this.
    if (value === undefined) continue;
    if (!first) await write(",");
    first = false;
    await write(`${JSON.stringify(key)}:`);

    if (isDeferredRows(value)) {
      await write("[");
      let rows = 0;
      for await (const row of value.rows()) {
        await write(
          rows === 0 ? JSON.stringify(row) : `,${JSON.stringify(row)}`,
        );
        rows++;
      }
      await write("]");
      bulkCounts[key] = rows;
    } else {
      await write(JSON.stringify(value));
    }
    delete payload[key];
  }
  await write("}");
  await flush(true);

  return { ...counts, ...bulkCounts } as FullBackupCounts;
}
