/**
 * A model-free turn: a reuse chip ("as a chart", "as a table") answered from
 * a table already stored on the conversation. No budget reservation and no
 * provider call; the capability and the rate limit still apply at the route.
 * Streams `step → token (caption) → provenance → result → followUps → done`
 * and persists an assistant message with `providerType: "reuse"`.
 *
 * Not built yet: answers null, and the turn runs as a plain model turn.
 */
import type { ResolvedFollowUp } from "@/lib/ai/coach/follow-ups/resolve";

import type { TurnConversation, TurnInput } from "./types";

export async function runReuseTurn(_args: {
  input: TurnInput;
  conversation: TurnConversation;
  resolved: ResolvedFollowUp;
}): Promise<Response | null> {
  return null;
}
