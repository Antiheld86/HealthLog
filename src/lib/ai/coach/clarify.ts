/**
 * Clarifying questions. The model may end a reply with a `---CLARIFY---`
 * block when the metric or window stays genuinely ambiguous; the server
 * validates the choices against what the record holds, and the question text
 * is the reply itself. The person answers with
 * `clarification: { messageId, choiceId? }` on the next request.
 *
 * Not built yet: the prose passes through unchanged, no clarification is
 * offered, and an answer adds nothing to the turn.
 */
import type { Locale } from "@/lib/i18n/config";
import type { CoachClarification } from "@/lib/ai/coach/types";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";

export function parseClarifySentinel(args: {
  prose: string;
  /** What the record holds; null on the no-tools path. */
  inventory: InventoryEntry[] | null;
  locale: Locale;
}): { prose: string; clarification: CoachClarification | null } {
  return { prose: args.prose, clarification: null };
}

/**
 * The turn-context line for an answered clarification, or null when the
 * request carries none or its question is no longer current.
 */
export async function resolveClarificationAnswer(_args: {
  userId: string;
  conversationId: string | undefined;
  clarification: { messageId: string; choiceId?: string } | undefined;
}): Promise<string | null> {
  return null;
}
