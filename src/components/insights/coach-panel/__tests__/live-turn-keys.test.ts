/**
 * v1.39.4 — a turn keeps one React key from its first streamed frame to
 * its persisted copy, so the bubble (and what the reader did in it) survives
 * the swap.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_LIVE_TURN_KEYS,
  messageRenderKey,
  nextLiveTurnKeys,
} from "../live-turn-keys";

type Frame = { inProgress: boolean; messageId: string | null } | undefined;

function run(frames: Frame[]) {
  let keys = EMPTY_LIVE_TURN_KEYS;
  const seen: Array<string | null> = [];
  for (const frame of frames) {
    keys = nextLiveTurnKeys(keys, frame);
    seen.push(keys.current);
  }
  return { keys, seen };
}

describe("live turn keys", () => {
  it("gives the persisted message the key its turn streamed under", () => {
    const { keys, seen } = run([
      undefined,
      { inProgress: true, messageId: null },
      { inProgress: true, messageId: null },
      { inProgress: false, messageId: "m-7" },
    ]);
    expect(seen.slice(1)).toEqual([
      "coach-turn-1",
      "coach-turn-1",
      "coach-turn-1",
    ]);
    expect(messageRenderKey(keys, "m-7")).toBe("coach-turn-1");
    // A message that never streamed here keeps its own id.
    expect(messageRenderKey(keys, "m-3")).toBe("m-3");
  });

  it("keeps an earlier turn's key when the next one streams", () => {
    const { keys } = run([
      { inProgress: true, messageId: null },
      { inProgress: false, messageId: "m-7" },
      { inProgress: true, messageId: null },
      { inProgress: false, messageId: "m-9" },
    ]);
    expect(messageRenderKey(keys, "m-7")).toBe("coach-turn-1");
    expect(messageRenderKey(keys, "m-9")).toBe("coach-turn-2");
  });

  it("answers the same keys for the same frame twice, so render can call it", () => {
    const first = nextLiveTurnKeys(EMPTY_LIVE_TURN_KEYS, {
      inProgress: true,
      messageId: null,
    });
    const again = nextLiveTurnKeys(first, {
      inProgress: true,
      messageId: null,
    });
    expect(again).toBe(first);
  });
});
