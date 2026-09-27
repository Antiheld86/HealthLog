/**
 * The React key a Coach turn keeps from its first streamed frame to its
 * persisted copy.
 *
 * A reply streams under a key minted when the turn starts; once the `done`
 * frame names its message id, the persisted message is rendered under that
 * same key. React then keeps one bubble through the swap, and with it what
 * the reader did while it streamed: the chart or table view, the open steps
 * list, the open evidence panel. Keyed by message id alone, the persisted
 * copy mounted as a new bubble and reset all of it.
 *
 * Pure and idempotent for the same input, so it can run during render.
 */
import type { CoachStreamingMessage } from "./use-coach";

export interface LiveTurnKeys {
  /** Turns started so far in this thread view. */
  seq: number;
  /** The key of the turn streaming now, or the last one that streamed. */
  current: string | null;
  wasInProgress: boolean;
  /** Message id → the key its turn streamed under. */
  byMessage: ReadonlyMap<string, string>;
}

export const EMPTY_LIVE_TURN_KEYS: LiveTurnKeys = {
  seq: 0,
  current: null,
  wasInProgress: false,
  byMessage: new Map(),
};

export function nextLiveTurnKeys(
  prev: LiveTurnKeys,
  streaming:
    Pick<CoachStreamingMessage, "inProgress" | "messageId"> | undefined,
): LiveTurnKeys {
  let next = prev;
  const inProgress = !!streaming?.inProgress;
  if (inProgress && !prev.wasInProgress) {
    const seq = prev.seq + 1;
    next = { ...next, seq, current: `coach-turn-${seq}` };
  }
  if (inProgress !== next.wasInProgress) {
    next = { ...next, wasInProgress: inProgress };
  }
  const id = streaming?.messageId;
  if (id && next.current && !next.byMessage.has(id)) {
    const byMessage = new Map(next.byMessage);
    byMessage.set(id, next.current);
    next = { ...next, byMessage };
  }
  return next;
}

/** The key a message renders under: its turn's, else its own id. */
export function messageRenderKey(
  keys: LiveTurnKeys,
  messageId: string,
): string {
  return keys.byMessage.get(messageId) ?? messageId;
}
