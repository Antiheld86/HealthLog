/**
 * The weekly backup, run against a record big enough to have killed the
 * process, with its live memory measured rather than assumed.
 *
 * What this pins. The `data-backup` job used to build the whole payload as an
 * object graph and then `JSON.stringify` it, so both the graph and the string
 * were resident at once and both scaled with the record. On a seeded account
 * of 445 000 measurements under `--max-old-space-size=450` that is
 * `FATAL ERROR: Reached heap limit` about thirty seconds in — and because the
 * job shares the app process, one account's size restarted the instance for
 * everybody on it.
 *
 * Why it measures the way it does. `process.memoryUsage().heapUsed` on its own
 * is not a measurement: V8 lets garbage float in proportion to the heap limit,
 * and a test fork's limit is several times a container's, so the same code
 * "peaks" at wildly different numbers depending on who is running it. Every
 * reading below is taken after a forced collection, so what is compared is
 * what each writer HOLDS.
 *
 * The two halves are the whole point. One says the streaming writer stays
 * inside a budget; the other says the materialising builder does not fit that
 * budget on the same fixture in the same process. Without the second, the
 * budget could be any number at all and the first would still pass — green
 * because nothing was measured rather than because something was proved.
 *
 * The fixture is seeded in one `INSERT … generate_series` rather than through
 * Prisma. 120 000 rows through the client would dominate the runtime and prove
 * nothing about the writer.
 */
import v8 from "node:v8";
import vm from "node:vm";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  packBackupBlobStreaming,
  unpackBackupBlob,
} from "@/lib/export/backup-blob";
import {
  BackupHeapBudgetExceededError,
  streamFullBackupJson,
} from "@/lib/export/full-backup-stream";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { getPrismaClient, truncateAllTables } from "./setup";

const OWNER_ID = "backup-streaming-owner";
const MEASUREMENT_ROWS = 120_000;
const MOOD_ROWS = 8_000;

/**
 * What the streaming writer may hold on top of the process's own baseline.
 *
 * Measured, not chosen: on this fixture the streaming writer holds 16 MB — a
 * page of rows and the base64 answer so far — and materialising the same
 * fixture holds 168 MB, the object graph and the document at once. The budget
 * sits with a wide margin either side of it, which is what makes it a test
 * rather than a coin toss.
 */
const STREAM_BUDGET_BYTES = 48 * 1024 * 1024;

const prisma = getPrismaClient();

/**
 * A collection this process can ask for, without the runner having to be
 * started with `--expose-gc`. The flag is turned on, the binding is pulled out
 * of a throwaway context, and the flag is turned back off — so nothing about
 * how the rest of the suite runs changes.
 */
const forceGc = ((): (() => void) => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
})();

/** Heap held after a forced collection. Garbage is not a measurement. */
function liveHeapBytes(): number {
  // Twice: the first pass frees the objects, the second collects what the
  // first pass's own bookkeeping released.
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

async function seedLargeRecord(): Promise<void> {
  await prisma.user.create({
    data: { id: OWNER_ID, username: "backup-streaming-owner" },
  });
  // One statement, one round trip. Every row carries a note on one row in
  // forty and ciphertext on one in twenty-five so the base64 arm of the
  // serialiser is exercised at scale, and one in two hundred is a tombstone
  // because the delta sync reads exactly those and a backup that drops them
  // resurrects deleted readings on the next device sync.
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at, notes,
       notes_encrypted, external_id, created_at, updated_at, sync_version,
       deleted_at)
     SELECT
       'sm' || lpad(g::text, 10, '0'),
       $1,
       'PULSE'::measurement_type,
       60 + (g % 40),
       'bpm',
       'APPLE_HEALTH'::measurement_source,
       timestamp '2019-01-01 00:00:00' + (g * interval '30 seconds'),
       CASE WHEN g % 40 = 0 THEN 'a note recorded with reading ' || g END,
       CASE WHEN g % 25 = 0
            THEN decode(md5(g::text) || md5((g + 1)::text), 'hex') END,
       'stream-' || g,
       timestamp '2019-01-01 00:00:00' + (g * interval '30 seconds'),
       timestamp '2019-01-01 00:00:00' + (g * interval '30 seconds'),
       1,
       CASE WHEN g % 200 = 0
            THEN timestamp '2026-01-01 00:00:00' + (g * interval '1 second') END
     FROM generate_series(1, ${MEASUREMENT_ROWS}) AS g`,
    OWNER_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO mood_entries (
       id, user_id, date, mood, score, source, mood_logged_at, synced_at,
       created_at, updated_at, tz, note, sync_version, deleted_at)
     SELECT
       'sd' || lpad(g::text, 10, '0'),
       $1,
       to_char(timestamp '2019-01-01' + (g * interval '1 hour'), 'YYYY-MM-DD'),
       'okay', 3, 'MOODLOG',
       timestamp '2019-01-01' + (g * interval '1 hour'),
       now(), now(), now(), 'Europe/Berlin',
       CASE WHEN g % 3 = 0 THEN 'a journal line about day ' || g END,
       1,
       CASE WHEN g % 150 = 0 THEN now() END
     FROM generate_series(1, ${MOOD_ROWS}) AS g`,
    OWNER_ID,
  );
}

describe("weekly backup under a memory budget", () => {
  beforeAll(async () => {
    expect(
      typeof forceGc,
      "without a real collection every reading in this file measures " +
        "uncollected garbage and nothing here can fail",
    ).toBe("function");
    await truncateAllTables(prisma);
    await seedLargeRecord();
  }, 240_000);

  afterAll(async () => {
    await truncateAllTables(prisma);
  });

  it("writes a restorable blob while holding a bounded amount of the record", async () => {
    const baseline = liveHeapBytes();
    let peakHeld = 0;
    let chunks = 0;

    const blob = await packBackupBlobStreaming(async (write) => {
      const counts = await streamFullBackupJson(
        prisma,
        OWNER_ID,
        async (chunk) => {
          await write(chunk);
          // Sampled rather than continuous: a forced collection per chunk
          // would dominate the runtime, and one in forty still lands inside
          // every phase of the walk.
          if (chunks++ % 40 === 0) {
            peakHeld = Math.max(peakHeld, liveHeapBytes() - baseline);
          }
        },
        // The purpose the weekly job asks for: tombstones and ciphertext ride
        // verbatim, which is the arm that has to fit in memory.
        { purpose: "disaster-recovery" },
      );
      expect(counts.measurements).toBe(MEASUREMENT_ROWS);
      expect(counts.moodEntries).toBe(MOOD_ROWS);
    });
    peakHeld = Math.max(peakHeld, liveHeapBytes() - baseline);

    expect(
      peakHeld,
      `the streaming writer held ${Math.round(peakHeld / 1024 / 1024)} MB of ` +
        "a record it is supposed to pass through a page at a time",
    ).toBeLessThan(STREAM_BUDGET_BYTES);

    // A blob that writes but does not read is worse than none.
    const restored = JSON.parse(unpackBackupBlob(blob)) as {
      measurements: Array<{ deletedAt: string | null }>;
      moodEntries: unknown[];
    };
    expect(restored.measurements).toHaveLength(MEASUREMENT_ROWS);
    expect(restored.moodEntries).toHaveLength(MOOD_ROWS);
    // Tombstones ride along, or the next device sync resurrects them.
    expect(
      restored.measurements.filter((row) => row.deletedAt !== null).length,
    ).toBe(Math.floor(MEASUREMENT_ROWS / 200));
  }, 300_000);

  it("would not fit that budget if the record were materialised", async () => {
    const baseline = liveHeapBytes();
    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    const json = JSON.stringify(payload);
    // Both are deliberately still reachable at the reading: holding the
    // graph and the document at the same time is exactly the shape that
    // exhausted the container.
    const held = liveHeapBytes() - baseline;
    expect(json.length).toBeGreaterThan(0);
    expect(payload.measurements).toHaveLength(MEASUREMENT_ROWS);
    expect(
      held,
      "materialising this fixture no longer costs what the budget in this " +
        "file assumes; re-measure the budget rather than widening it",
    ).toBeGreaterThan(STREAM_BUDGET_BYTES * 2);
  }, 300_000);

  it("fails as a job rather than as a process when the record does not fit", async () => {
    // The budget the writer enforces on itself is the reason an oversized
    // account is now a failed backup for that account instead of a restart
    // for every account on the host.
    await expect(
      packBackupBlobStreaming((write) =>
        streamFullBackupJson(prisma, OWNER_ID, write, {
          purpose: "disaster-recovery",
          heapCeilingBytes: 1,
        }),
      ),
    ).rejects.toBeInstanceOf(BackupHeapBudgetExceededError);
  }, 120_000);
});
