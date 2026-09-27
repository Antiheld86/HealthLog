/**
 * Expire every delta cursor an account's paired clients hold.
 *
 * Called when the account's record is replaced wholesale: a backup restore
 * (inside its transaction and again right after the commit) and the
 * person's delete-all-data. `/api/sync/changes` answers `cursorExpired` to
 * any cursor issued before the stamp, and the client re-initialises. See
 * `User.syncResetAt` in the schema for why an incremental catch-up from such
 * a cursor would miss rows.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

export async function stampSyncReset(
  db: Pick<PrismaClient | Prisma.TransactionClient, "user">,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { syncResetAt: at } });
}
