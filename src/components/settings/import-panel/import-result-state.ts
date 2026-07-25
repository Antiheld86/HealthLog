/**
 * Import result classification — the one place that decides whether an
 * import reads as a success.
 *
 * A per-row importer answers HTTP 200 for a file where every single row was
 * refused; the transport succeeded, the import did not. Rendering that as a
 * green tick is how a self-hoster's 1 597-reading sensor export could write
 * nothing and still look finished. So the counts, not the status code, pick
 * the state:
 *
 *   - nothing accepted, nothing skipped → `empty`   (the file carried no data)
 *   - nothing accepted, rows skipped    → `failed`  (never a success tone)
 *   - some accepted, some skipped       → `partial` (a warning, not a tick)
 *   - all accepted                      → `success`
 *
 * Both import cards render from this, and `import-result-state.test.ts` pins
 * the invariant that `success` is unreachable while `written === 0`.
 */

export type ImportOutcome = "empty" | "failed" | "partial" | "success";

export interface ImportCounts {
  /** Rows that reached the database — inserted + updated. */
  written: number;
  /** Rows the importer refused, for any reason. */
  skipped: number;
}

export function classifyImportOutcome({
  written,
  skipped,
}: ImportCounts): ImportOutcome {
  if (written <= 0) return skipped > 0 ? "failed" : "empty";
  return skipped > 0 ? "partial" : "success";
}

export interface SkipReasonGroup {
  /** The machine-readable reason as the route reported it. */
  reason: string;
  count: number;
}

/** A row of the per-row envelope, narrowed to what the grouping needs. */
export interface ImportRowResult {
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
  rows: readonly ImportRowResult[],
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
