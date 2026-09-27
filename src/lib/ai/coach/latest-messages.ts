/**
 * The newest few messages of an owned conversation, read once per turn.
 *
 * A tapped chip, an answered clarification, "keep looking" and the
 * never-two-questions check all look at the conversation's latest reply. They
 * share one read: the turn creates the loader when it resolves the
 * conversation, and the first caller runs the query. The owner narrowing is
 * in the query itself (`conversation: { userId }`), so the rows are never
 * another account's.
 */
import { prisma } from "@/lib/db";

/** How many of the newest messages a turn looks at. */
export const LATEST_MESSAGES_TAKE = 4;

export interface LatestMessage {
  id: string;
  role: string;
  providerType: string | null;
  metricSourceJson: string | null;
}

/** A turn's shared read of its conversation's latest messages, newest first. */
export type LatestMessagesLoader = () => Promise<LatestMessage[]>;

/** The newest messages of an owned conversation, newest first. */
export function readLatestMessages(
  userId: string,
  conversationId: string,
): Promise<LatestMessage[]> {
  return prisma.coachMessage.findMany({
    where: { conversationId, conversation: { userId } },
    orderBy: { createdAt: "desc" },
    take: LATEST_MESSAGES_TAKE,
    select: {
      id: true,
      role: true,
      providerType: true,
      metricSourceJson: true,
    },
  });
}

/**
 * A loader that reads once and hands every caller the same rows. A failed
 * read is not cached: each caller already treats an unreadable conversation
 * as "nothing to resolve", and the next may succeed.
 */
export function latestMessagesOnce(
  userId: string,
  conversationId: string,
): LatestMessagesLoader {
  let pending: Promise<LatestMessage[]> | null = null;
  return () => {
    pending ??= readLatestMessages(userId, conversationId).catch((err) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}
