/**
 * v1.11.0 — pg-boss queue + boot-time self-converging backfill for newly
 * connected WHOOP accounts. Modelled on the `rollup-full-backfill` /
 * step-consolidation boot pattern: a discovery query enqueues one job per
 * connection that has NOT yet been backfilled, the per-user handler runs a
 * full-history sync, and the pass is idempotent across reboots (the discovery
 * predicate `backfill_completed_at IS NULL` drops a connection once its
 * backfill finishes).
 *
 * The full sync walks each collection from the far-past anchor to now via
 * `next_token` (the client caps `limit` at 25 and stops on an empty cursor).
 * Multi-year history is low-thousands of requests — well under WHOOP's
 * 10 000 req/day app cap.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` or pg-boss never provisions it and the
 * boot enqueue silently never drains (the v1.4.37 dead-queue class).
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { integrationBackfillSourceOptions } from "@/lib/jobs/integration-backfill-admission";
import { isReauthRequired } from "@/lib/integrations/status";
import { syncUserWhoop } from "@/lib/whoop/sync";

export const WHOOP_BACKFILL_QUEUE = "whoop-backfill";

/**
 * Serial concurrency — a backfill walks years of history for one account and
 * is rate-bounded by WHOOP's 100 req/min cap; concurrency-1 keeps it from
 * crowding the request pool, matching `ROLLUP_FULL_BACKFILL_CONCURRENCY`.
 */
export const WHOOP_BACKFILL_CONCURRENCY = 1;

export interface WhoopBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user backfill handler. Runs a full-history sync for one account and stamps
 * `backfillCompletedAt` ONLY on a clean run, so the discovery query drops it.
 * Idempotent: the per-resource upserts are key-stable, so a re-run (e.g. a
 * reboot mid-walk) overwrites rather than duplicating. Mirrors the landed
 * `runFitbitBackfillForUser`.
 *
 * Verdict-gated: a partial hard failure (a dead token, a write failing, a
 * fetch hard-fail) THROWS so pg-boss retries the job — stamping the marker over
 * a partial multi-year walk would freeze the history gap forever and the
 * configured `retryLimit` would be dead code. A connection parked at
 * `error_reauth` is NOT clean either, but throwing against a dead grant would
 * just burn the retry budget on the same no-op: return WITHOUT stamping — boot
 * discovery re-offers the account after the user reconnects and a clean walk
 * completes. `syncUserWhoop` has its own reauth short-circuit (returns
 * `failed: true`), but the guard must still live here so a parked account
 * RETURNS instead of throwing through three retries.
 */
export async function runWhoopBackfillForUser(
  userId: string,
): Promise<{ imported: number }> {
  if (await isReauthRequired(userId, "whoop")) {
    annotate({
      action: {
        name: "whoop.backfill.skipped_reauth",
        details: { imported: 0 },
      },
    });
    return { imported: 0 };
  }

  const { imported, failed } = await syncUserWhoop(userId, { fullSync: true });

  if (failed) {
    // Surface through the pg-boss retry path (retryLimit + backoff set by
    // `integrationBackfillSourceOptions`). If the failure parked the connection
    // at error_reauth meanwhile, the next attempt takes the reauth return above.
    throw new Error(
      `whoop backfill incomplete for user ${userId} — marker not stamped`,
    );
  }

  await prisma.whoopConnection.update({
    where: { userId },
    data: { backfillCompletedAt: new Date() },
  });

  annotate({
    action: {
      name: "whoop.backfill.complete",
      details: { imported },
    },
  });
  return { imported };
}

/**
 * Boot-time discovery. Finds every WHOOP connection not yet backfilled
 * (`backfill_completed_at IS NULL`) and enqueues one backfill job per account.
 *
 * Idempotent across reboots: once a connection's backfill completes,
 * `backfillCompletedAt` is set and the predicate drops it from the discovery
 * set. pg-boss `singletonKey` coalesces duplicate sends so a fast restart
 * while a job is queued doesn't double up.
 *
 * Best-effort: errors are returned through the result value so the worker boot
 * never fails because of a backfill miss.
 */
export async function enqueueBootTimeWhoopBackfill(
  startAfterSeconds: number = 0,
): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    const connections = await prisma.whoopConnection.findMany({
      where: { backfillCompletedAt: null },
      select: { userId: true },
    });

    if (connections.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of connections) {
      const payload: WhoopBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        WHOOP_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `whoop-backfill|${userId}`,
          startAfterSeconds,
        ),
      );
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
