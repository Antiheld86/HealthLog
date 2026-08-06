/**
 * `GET /api/account/activity` — who opened this account's record, and when.
 *
 * The owner's side of the audit actor. Every row filed under this account that
 * somebody ELSE performed, newest first: the day-coalesced read rows the
 * delegated resolver writes, and any delegated action that lands an audit row
 * of its own. Rows the owner performed themselves are absent by construction —
 * `actorUserId` is null for those, and this feed is not a second copy of the
 * security-activity feed.
 *
 * **The window is published, not implied.** `retentionDays` rides the response
 * because audit rows are purged on a schedule the operator configures
 * (`AUDIT_LOG_RETENTION_DAYS`, 365 by default) and a view that showed "the
 * activity" without saying how far back it goes would claim a completeness it
 * does not have. The number is resolved server-side from the same function the
 * purge job uses, so the sentence in the UI cannot drift from the job that
 * makes it true — an instance running a 90-day window says 90.
 *
 * **And the window is now enforced, not only stated.** The query is bounded to
 * it. Without the filter the two halves of the same sentence disagreed: the
 * revoke dialog promised attribution "for the next N days" while this read
 * returned whatever the last hundred rows happened to be, which on a quiet
 * record reaches back past a shortened retention window and on a busy one
 * covers a fortnight. The bound the copy states is the bound the query uses.
 *
 * **The row cap says when it was hit.** A hundred rows is a display bound, and
 * a list that silently stops at its own ceiling is the more dangerous of the
 * two completeness lies — an owner scrolling to the bottom reads the oldest
 * line as the beginning. `truncated` is true when the cap was reached, and the
 * view says it is showing the most recent activity rather than all of it.
 * `false` means the list IS everything inside the window.
 *
 * Not delegable: bare `requireAuth()` refuses under a switch. A delegate must
 * not be able to read the owner's record of who has been in it — that list
 * names other delegates, and a grant is not an introduction to the household.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { DELEGATED_ACCESS_ACTION } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { getAuditLogRetentionDays } from "@/lib/jobs/audit-log-cleanup";
import { annotate } from "@/lib/logging/context";
import { GRANT_PARTY_SELECT } from "@/lib/sharing/grant-view";

export const dynamic = "force-dynamic";

/**
 * How many rows the feed returns. One row per (delegate, day) for reads, so a
 * hundred covers months of a busy household — and a longer list answers a
 * question nobody asked while making the recent activity harder to see.
 *
 * The cap is a display bound, not a completeness claim, and the response says
 * which it hit. See {@link GET}.
 */
const MAX_ROWS = 100;

export interface RecordActivityEntry {
  id: string;
  /**
   * Who did it. Null when that account has since been deleted: the id on the
   * row is deliberately not a foreign key, so history is not rewritten when a
   * person leaves. A row whose actor cannot be resolved says "a deleted
   * account", which is true, rather than silently reading as the owner's own.
   */
  actor: { id: string; username: string; displayName: string | null } | null;
  action: string;
  /**
   * For a coalesced read row, how many times that delegate opened the record
   * that day. Null for anything else — a single act has no count, and a `1`
   * there would invite the reader to add up numbers that mean different things.
   */
  accesses: number | null;
  createdAt: string;
}

/** The `accesses` counter, when the row is a coalesced read. */
function readAccessCount(
  action: string,
  details: string | null,
): number | null {
  if (action !== DELEGATED_ACCESS_ACTION || details === null) return null;
  try {
    const parsed: unknown = JSON.parse(details);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as { accesses?: unknown }).accesses;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    // A row whose details cannot be parsed still happened. Dropping the count
    // loses a number; dropping the row would lose the access.
    return null;
  }
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // The same number the response publishes and the purge job reads, resolved
  // once so the filter and the sentence cannot disagree.
  const retentionDays = getAuditLogRetentionDays();
  const windowStart = new Date(Date.now() - retentionDays * 86_400_000);

  const rows = await prisma.auditLog.findMany({
    where: {
      userId: user.id,
      actorUserId: { not: null },
      // A switch into one's own record is not a delegation and has nothing to
      // report. `actingActorFor` already refuses to stamp one, so this is the
      // second end of that rule rather than its only enforcement.
      NOT: { actorUserId: user.id },
      // The window the copy promises. The purge job makes it true eventually;
      // this makes it true now, which matters on an instance whose retention
      // was shortened after rows were already written.
      createdAt: { gte: windowStart },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: {
      id: true,
      actorUserId: true,
      action: true,
      details: true,
      createdAt: true,
    },
  });

  const actorIds = [
    ...new Set(rows.map((r) => r.actorUserId).filter((id) => id !== null)),
  ];
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: GRANT_PARTY_SELECT,
  });
  const byId = new Map(actors.map((a) => [a.id, a]));

  const entries: RecordActivityEntry[] = rows.map((row) => ({
    id: row.id,
    actor: row.actorUserId ? (byId.get(row.actorUserId) ?? null) : null,
    action: row.action,
    accesses: readAccessCount(row.action, row.details),
    createdAt: row.createdAt.toISOString(),
  }));

  // Equality, not `>=`: `take` cannot return more than it was given, and a
  // `>` would be a comparison that can never be true.
  const truncated = rows.length === MAX_ROWS;

  annotate({
    action: { name: "sharing.activity.list" },
    meta: { entry_count: entries.length, truncated },
  });

  return apiSuccess({
    entries,
    // The bound the view states out loud. Resolved here so the UI never has to
    // hardcode a number the operator can change.
    retentionDays,
    // Whether the list is everything inside that window, or its most recent
    // hundred rows. The view says which; silence would let the oldest line
    // read as the beginning.
    truncated,
  });
});
