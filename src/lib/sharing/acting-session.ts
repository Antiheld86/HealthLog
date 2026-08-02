/**
 * v1.36.0 — the only writer of `Session.actingAsUserId`.
 *
 * The column is the cookie transport's acting-account carrier. Two things
 * write it and they are opposite acts: the switch endpoint points a browser
 * session at a record, and the end of a grant points every affected session
 * back at its own. Both live here rather than at their call sites so the
 * carrier has one writer, the same way it has one reader (the resolver in
 * `src/lib/api-handler.ts`). The structural guard in
 * `src/__tests__/acting-account-boundary-guard.test.ts` holds that shape: any
 * other file that so much as names the column fails it.
 *
 * Nothing here authorises anything. `pointSessionAt` writes an id its caller
 * has already proven, and the resolver re-checks the grant on every request
 * regardless — a value stranded here by a grant that has since ended confers
 * exactly nothing. The clearing below is therefore housekeeping, not
 * enforcement: it exists so a delegate's browser lands back in its own account
 * instead of on a wall of 403s. Enforcement already happened when the grant
 * row was stamped.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * The narrow client slice these functions need, so a caller can hand them a
 * transaction handle. Same shape as `grants.ts` uses for `accountGrant`.
 */
type SessionDb = Pick<Prisma.TransactionClient, "session">;

/**
 * Point one browser session at an account's record, or (with `null`) back at
 * its own.
 *
 * Scoped by session id AND the caller's own user id. The id alone would be
 * enough in every code path that exists today; pinning the owner as well means
 * a future caller that gets a session id from somewhere less trustworthy than
 * `requireActorAuth` cannot use this to steer somebody else's browser.
 */
export async function pointSessionAt(
  sessionId: string,
  userId: string,
  actingAsUserId: string | null,
  db: SessionDb = prisma,
): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, userId },
    data: { actingAsUserId },
  });
}

/**
 * Drop every session of `granteeId` that is currently acting as `grantorId`.
 *
 * Called inside the transaction that ends a grant, which is the point: the
 * grant row and the sessions pointing at it stop being true in one atomic
 * step. Split across two statements, a revocation that failed halfway would
 * leave a browser sitting inside a record it no longer has access to — every
 * request refused, the banner still claiming otherwise, and nothing in the UI
 * able to explain it.
 *
 * Returns the number of sessions cleared, so the caller can put it on the wide
 * event: "revoked, and dropped her out of it" is a different fact from
 * "revoked", and the owner pressing the button deserves to know which happened.
 */
export async function clearActingSessions(
  pair: { grantorId: string; granteeId: string },
  db: SessionDb = prisma,
): Promise<number> {
  const { count } = await db.session.updateMany({
    where: { userId: pair.granteeId, actingAsUserId: pair.grantorId },
    data: { actingAsUserId: null },
  });
  return count;
}
