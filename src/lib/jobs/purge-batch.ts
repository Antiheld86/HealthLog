/**
 * Batched retention purges.
 *
 * The retention jobs used to issue one unbounded `deleteMany` over a predicate
 * no index supported. Every `deleted_at` index in the schema is PARTIAL on
 * `IS NULL` — the live-rows predicate, the exact opposite of what a purge asks
 * for — so the purge planned a sequential scan and then paid index maintenance
 * on every row it removed. Below the 60-second `statement_timeout` the
 * connection carries (`src/lib/db.ts`) that is invisible; above it the
 * statement aborts, the transaction rolls back, nothing is purged, and the job
 * runs the identical statement again the next night. A backlog that grows past
 * the timeout can therefore never be drained by the mechanism meant to drain
 * it, and the job that was supposed to make deletion real never completes.
 *
 * The fix has three parts and this file is one of them:
 *   - the predicates get indexes that match them (migration 0277);
 *   - the delete runs in bounded batches, so no single statement is on the
 *     hook for the whole backlog;
 *   - a run that stops at the cap says so, so "still draining" and "nothing
 *     left to do" stop looking identical from the outside.
 */

/** Rows removed per statement. */
export const PURGE_BATCH_SIZE = 5_000;

/**
 * Batches per run. 40 × 5 000 = 200 000 rows a night, which drains a large
 * backlog over a handful of nights instead of asking one statement to survive
 * it. The cap exists so a nightly job cannot hold connections and bloat WAL
 * for an unbounded stretch on a instance that has accumulated years of rows.
 */
export const PURGE_MAX_BATCHES = 40;

export interface PurgeOutcome {
  /** Rows removed this run. */
  deleted: number;
  /**
   * `false` when the run stopped at {@link PURGE_MAX_BATCHES} with rows still
   * matching. The next run continues; an operator watching this stay `false`
   * for many nights is watching a backlog that needs a wider window.
   */
  drained: boolean;
}

export interface PurgeBatchOptions {
  /** Ids of up to `take` rows matching the retention predicate. */
  findIds: (take: number) => Promise<string[]>;
  /** Remove exactly those ids; returns the row count actually removed. */
  deleteIds: (ids: string[]) => Promise<number>;
  batchSize?: number;
  maxBatches?: number;
}

/**
 * Delete rows matching a retention predicate in bounded batches.
 *
 * Selecting ids first and deleting by primary key keeps each statement small
 * and predictable regardless of how selective the predicate is, and keeps the
 * scan on the index that supports the predicate rather than on the delete.
 */
export async function purgeInBatches({
  findIds,
  deleteIds,
  batchSize = PURGE_BATCH_SIZE,
  maxBatches = PURGE_MAX_BATCHES,
}: PurgeBatchOptions): Promise<PurgeOutcome> {
  let deleted = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const ids = await findIds(batchSize);
    if (ids.length === 0) return { deleted, drained: true };

    deleted += await deleteIds(ids);

    // A short final batch means the predicate is exhausted; asking again would
    // cost a round-trip to learn nothing.
    if (ids.length < batchSize) return { deleted, drained: true };
  }

  return { deleted, drained: false };
}
