/**
 * Written-outcome classification — the one place that decides whether a write
 * reads as a success.
 *
 * The rule started in the import panel (`import-result-state.ts`, #640/#650)
 * and is unchanged; only its reach is wider. A per-row importer answers HTTP
 * 200 for a file where every single row was refused, and a provider sync
 * answers HTTP 200 for a run where every reading failed a constraint. The
 * transport succeeded, the write did not. Rendering either as a green tick is
 * how a self-hoster's sensor export could write nothing and still look
 * finished. So the counts, not the status code, pick the state:
 *
 *   - nothing written, nothing refused → `empty`   (there was nothing to write)
 *   - nothing written, rows refused    → `failed`  (never a success tone)
 *   - some written, some refused       → `partial` (a warning, not a tick)
 *   - everything written               → `success`
 *
 * `empty` is deliberately its own state rather than a failure: an import of a
 * file with no data rows and a sync that finds nothing new are both honest
 * non-events, and both would be a lie under a tick.
 *
 * Every surface that reports a write routes through this, and
 * `success-affordance-guard.test.ts` holds the line that the tick and the
 * success colour live only in the presentation module this feeds.
 */

export type WrittenOutcome = "empty" | "failed" | "partial" | "success";

export interface WriteCounts {
  /** Rows that reached the database — inserted + updated. */
  written: number;
  /** Rows the write refused, for any reason. */
  skipped: number;
}

export function classifyWrittenOutcome({
  written,
  skipped,
}: WriteCounts): WrittenOutcome {
  if (written <= 0) return skipped > 0 ? "failed" : "empty";
  return skipped > 0 ? "partial" : "success";
}

/**
 * What a provider sync reports back to its route.
 *
 * Three providers (Fitbit, Google Health, WHOOP) already answered in this
 * shape; the rest returned a bare count that narrowed their failures away —
 * a Nightscout run whose every SGV row failed to write returned the same `0`
 * as a run that found nothing new. The boolean is the honest floor: a sync
 * knows a leg / collection / row did not land, but not always how many.
 */
export interface SyncWriteResult {
  /** Rows that reached the database this run. */
  imported: number;
  /** True when any part of the run did not land — a row, a collection, a leg. */
  failed: boolean;
}

/** The sync envelope a route answers with: the counts plus the resolved tone. */
export interface ResolvedSyncOutcome extends SyncWriteResult {
  outcome: WrittenOutcome;
}

/**
 * Resolve a sync's write result to the outcome its card renders.
 *
 * Server-side on purpose: the verdict is the server's to compute, so the web
 * card and the native client cannot drift on how the same run reads. A failed
 * leg counts as one refusal — enough to move `success` to `partial` and
 * `empty` to `failed`, which is the whole point.
 */
export function resolveSyncOutcome({
  imported,
  failed,
}: SyncWriteResult): ResolvedSyncOutcome {
  return {
    imported,
    failed,
    outcome: classifyWrittenOutcome({
      written: imported,
      skipped: failed ? 1 : 0,
    }),
  };
}

export interface SkipReasonGroup {
  /** The machine-readable reason as the route reported it. */
  reason: string;
  count: number;
}

/** A row of the per-row envelope, narrowed to what the grouping needs. */
export interface WrittenRowResult {
  line: number;
  status: string;
  reason?: string;
}

const UNKNOWN_REASON = "unknown";

/**
 * Collapse the per-row envelope into one entry per skip reason.
 *
 * A sensor export that trips one validation trips it on every row, so the
 * raw list is the same sentence a few thousand times. Grouping turns "scroll
 * fifty identical lines" into one fact with a count. Ordered by count
 * descending, then by reason, so the same result always renders the same way.
 */
export function groupSkipReasons(
  rows: readonly WrittenRowResult[],
): SkipReasonGroup[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== "skipped") continue;
    const reason = row.reason ?? UNKNOWN_REASON;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}
