/**
 * The SyncMode checkpoint — `User.lastSyncedAt`.
 *
 * One writer contract: the checkpoint is stamped by the client-push ingest
 * boundaries (the measurement / mood / intake batch endpoints), never by the
 * handshake that reports it. `GET /api/sync/state` is the only reader, so the
 * column has to describe a sync that actually moved data rather than the fact
 * that a client asked what the server knows.
 *
 * Stamping it on the handshake was also unsafe in exactly the watermark sense
 * the provider pipelines already guard against (`sync-measure-watermark`,
 * `sync-dead-token`): it advanced the checkpoint past a window the client had
 * not drained yet, and a client that trusts the checkpoint then skips that
 * window. Under-advancing a watermark costs a redundant fetch; over-advancing
 * loses rows. Stamped here, the checkpoint can only ever trail the truth.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

/**
 * Stamp `User.lastSyncedAt`. Call from an ingest boundary once the batch has
 * reached a durable verdict — never from a read.
 */
export async function markSyncCheckpoint(
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { lastSyncedAt: at },
  });
  annotate({ meta: { sync_checkpoint_at: at.toISOString() } });
}
