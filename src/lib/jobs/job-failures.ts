/**
 * What the queue already knows about its own broken jobs, read back out.
 *
 * The `environment-fetch` job threw on every single run for the whole life of
 * the environmental-context module. It was handled correctly at the call site —
 * `recordError()`, a `workerLog("error", …)`, a rethrow so pg-boss retries —
 * and none of that reached a screen. `recordError()` increments one unnamed
 * counter, so `/api/admin/status` could say "errors: 41" and not which queue.
 * The worker log only exists where someone is tailing the container. The user
 * saw "0 days recorded" and had no way to tell an empty module from a broken
 * one.
 *
 * pg-boss has held the answer the whole time: a job that exhausts its retries
 * lands in `pgboss.job` with `state = 'failed'`, its queue name, the thrown
 * error in `output`, and the instant it gave up. Reading that back is a
 * complete signal for every queue at once, and it needs nothing from the ~30
 * `recordError()` call sites — which is the point, because a visibility fix
 * that has to be remembered at each call site is the same failure mode one
 * level up.
 *
 * Both readers fail soft to `null`. The `pgboss` schema is created by the
 * worker, so a web-only deployment legitimately has no such table, and the
 * admin status page must not 500 because the queue is absent. `null` means "no
 * queue to ask", which is not the same fact as an empty array ("asked, nothing
 * broken") — the callers keep the two apart.
 */
import { prisma } from "@/lib/db";
import { redactSecrets } from "@/lib/logging/redact";

/** How far back a failure still counts as news. */
export const JOB_FAILURE_WINDOW_HOURS = 72;

/** Queues named in one report — enough to see a pattern, bounded for the wire. */
const MAX_QUEUES = 20;

/** The error text is for a human reading a status page, not for a stack trace. */
const MAX_ERROR_CHARS = 300;

export interface FailingQueue {
  /** The pg-boss queue name, e.g. `environment-fetch`. */
  queue: string;
  /** Jobs that exhausted their retries inside the window. */
  failures: number;
  /** ISO instant of the newest failure. */
  lastFailedAt: string;
  /** The newest failure's message, redacted and truncated. */
  lastError: string;
}

interface FailingQueueRow {
  name: string;
  failures: number;
  last_failed_at: Date | null;
  last_error: string | null;
}

/**
 * Turn whatever pg-boss stored in `output` into one line. A thrown `Error`
 * serialises to `{ message, stack, … }`; a thrown non-Error can be any JSON at
 * all, so the raw text is the fallback rather than an invented placeholder.
 */
function presentError(raw: string | null): string {
  if (raw === null) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const redacted = redactSecrets(trimmed);
  return redacted.length > MAX_ERROR_CHARS
    ? `${redacted.slice(0, MAX_ERROR_CHARS)}…`
    : redacted;
}

/**
 * Every queue with at least one exhausted-retry failure in the window, newest
 * first. `null` when the queue schema is not present at all.
 */
export async function readFailingQueues(
  withinHours: number = JOB_FAILURE_WINDOW_HOURS,
): Promise<FailingQueue[] | null> {
  try {
    const rows = await prisma.$queryRaw<FailingQueueRow[]>`
      SELECT
        name,
        count(*)::int AS failures,
        max(completed_on) AS last_failed_at,
        (
          array_agg(
            COALESCE(output->>'message', output::text)
            ORDER BY completed_on DESC NULLS LAST
          )
        )[1] AS last_error
      FROM pgboss.job
      WHERE state = 'failed'
        AND completed_on > now() - make_interval(hours => ${withinHours}::int)
      GROUP BY name
      ORDER BY max(completed_on) DESC
      LIMIT ${MAX_QUEUES}
    `;
    return rows
      .filter((row) => row.last_failed_at !== null)
      .map((row) => ({
        queue: row.name,
        failures: row.failures,
        lastFailedAt: row.last_failed_at!.toISOString(),
        lastError: presentError(row.last_error),
      }));
  } catch {
    // No `pgboss` schema (web-only deployment) or no permission to read it.
    // Absence of a queue is not a failing queue, and it is not zero either.
    return null;
  }
}

export interface QueueFailureForUser {
  /** ISO instant the user's newest job on this queue gave up. */
  lastFailedAt: string;
  /** Failures for this user on this queue inside the window. */
  failures: number;
}

/**
 * The newest exhausted-retry failure of `queue` for one account, matched on the
 * `userId` the job payload carries. Used by a user-facing surface to say "the
 * last background run failed" instead of rendering a zero as if it were a
 * measurement. Deliberately carries no error text: the message is written for
 * an operator and can name internals, so a non-admin reader gets the fact and
 * the time only.
 */
export async function readQueueFailureForUser(
  queue: string,
  userId: string,
  withinHours: number = JOB_FAILURE_WINDOW_HOURS,
): Promise<QueueFailureForUser | null> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{ failures: number; last_failed_at: Date | null }>
    >`
      SELECT count(*)::int AS failures, max(completed_on) AS last_failed_at
      FROM pgboss.job
      WHERE name = ${queue}
        AND state = 'failed'
        AND data->>'userId' = ${userId}
        AND completed_on > now() - make_interval(hours => ${withinHours}::int)
    `;
    const row = rows[0];
    if (!row || row.last_failed_at === null || row.failures === 0) return null;
    return {
      lastFailedAt: row.last_failed_at.toISOString(),
      failures: row.failures,
    };
  } catch {
    return null;
  }
}
