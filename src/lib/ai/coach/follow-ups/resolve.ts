/**
 * Resolve a tapped follow-up chip (`followUp: { messageId, id }` on the
 * request) against what the server persisted: the chip must sit on the
 * conversation's latest assistant message. A reuse chip is answered from the
 * stored table without a model call; any other becomes a turn-context hint.
 * A chip that is no longer current degrades to a plain message.
 *
 * Not built yet: every request is a plain message.
 */
import type { CoachFollowUp } from "@/lib/ai/coach/types";

/** A chip that resolved: what it asks for, and how it is answered. */
export interface ResolvedFollowUp {
  sourceMessageId: string;
  followUp: CoachFollowUp;
  /** A line for the turn context, on a chip answered by the model. */
  contextHint: string | null;
}

export async function resolveFollowUp(_args: {
  userId: string;
  conversationId: string | undefined;
  followUp: { messageId: string; id: string } | undefined;
}): Promise<ResolvedFollowUp | null> {
  return null;
}
