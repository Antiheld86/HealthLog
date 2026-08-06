/**
 * The browser's half of the record-session fence: what it asserts on a request,
 * and what it does with the context a response echoes back.
 *
 * The two halves of the response rule are worth stating as opposites, because
 * getting either backwards is a live defect:
 *
 *   * a MISMATCHING echo is discarded — the answer is about a record this
 *     browser has left, and serving it paints one person's numbers under
 *     another person's name;
 *   * an ABSENT echo is served normally — it means the response resolved no
 *     record scope, which is true of every public route, actor surface, admin
 *     surface and static response. `/api/version` is polled on a timer through
 *     `apiGet`, so a discard-on-absence rule would put the browser into a
 *     permanent hold-and-reconcile loop.
 *
 * Break it by making `validateResponseContext` discard on absence: the
 * `/api/version`-shaped case fails, and no hold is entered.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  RECORD_EPOCH_HEADER,
  RECORD_FENCE_BOOTSTRAP,
  RECORD_SCOPE_HEADER,
  RECORD_SCOPE_SELF,
} from "@/lib/sharing/record-session-fence-contract";
import {
  RecordContextMismatchError,
  __resetRecordFenceForTests,
  adoptRecordFenceState,
  currentAssertion,
  currentRecordFenceState,
  onRecordFenceMismatch,
  validateResponseContext,
  withRecordFenceHeaders,
} from "@/lib/api/record-fence";

const OWNER = "owner-account-id";

function respond(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ data: null, error: null }), {
    status: 200,
    headers,
  });
}

/** What `/api/version` looks like on the wire: 2xx, no record echo. */
function publicResponse(): Response {
  return respond({ "content-type": "application/json" });
}

function echoing(epoch: number, scope: string | null): Response {
  return respond({
    [RECORD_EPOCH_HEADER]: String(epoch),
    [RECORD_SCOPE_HEADER]: scope ?? RECORD_SCOPE_SELF,
  });
}

beforeEach(() => {
  __resetRecordFenceForTests();
});

afterEach(() => {
  __resetRecordFenceForTests();
});

describe("what the browser asserts on a request", () => {
  it("sends the bootstrap sentinel before anything has been adopted", () => {
    expect(currentAssertion()).toEqual({
      epoch: RECORD_FENCE_BOOTSTRAP,
      scope: RECORD_FENCE_BOOTSTRAP,
    });
    const init = withRecordFenceHeaders();
    const headers = new Headers(init.headers);
    // Present, not absent. Header-absent means exactly one thing on the wire —
    // a bundle that predates the fence — and a fence-aware client must never
    // be mistaken for one.
    expect(headers.get(RECORD_EPOCH_HEADER)).toBe(RECORD_FENCE_BOOTSTRAP);
    expect(headers.get(RECORD_SCOPE_HEADER)).toBe(RECORD_FENCE_BOOTSTRAP);
  });

  it("sends the adopted context once /me has answered", () => {
    adoptRecordFenceState({ epoch: 4, scope: OWNER });
    const headers = new Headers(withRecordFenceHeaders().headers);
    expect(headers.get(RECORD_EPOCH_HEADER)).toBe("4");
    expect(headers.get(RECORD_SCOPE_HEADER)).toBe(OWNER);
  });

  it("spells one's own record as the self sentinel", () => {
    adoptRecordFenceState({ epoch: 2, scope: null });
    const headers = new Headers(withRecordFenceHeaders().headers);
    expect(headers.get(RECORD_SCOPE_HEADER)).toBe(RECORD_SCOPE_SELF);
  });

  it("keeps caller headers and does not overwrite an explicit assertion", () => {
    adoptRecordFenceState({ epoch: 4, scope: OWNER });
    const init = withRecordFenceHeaders({
      headers: {
        "content-type": "application/json",
        [RECORD_EPOCH_HEADER]: "1",
      },
    });
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get(RECORD_EPOCH_HEADER)).toBe("1");
  });

  it("un-adopts on a null context rather than keeping a stale one", () => {
    adoptRecordFenceState({ epoch: 4, scope: OWNER });
    adoptRecordFenceState(null);
    expect(currentRecordFenceState()).toBeNull();
    expect(currentAssertion().epoch).toBe(RECORD_FENCE_BOOTSTRAP);
  });
});

describe("what the browser does with an echoed context", () => {
  it("serves a response carrying no echo, and enters no hold", () => {
    // The `/api/version` case, named because it is the concrete thing a
    // discard-on-absence rule breaks: it is polled on a timer.
    adoptRecordFenceState({ epoch: 4, scope: OWNER });
    const hold = vi.fn();
    onRecordFenceMismatch(hold);

    const res = publicResponse();
    expect(validateResponseContext(res)).toBe(res);
    expect(hold).not.toHaveBeenCalled();
  });

  it("serves a response whose echo agrees", () => {
    adoptRecordFenceState({ epoch: 4, scope: OWNER });
    const hold = vi.fn();
    onRecordFenceMismatch(hold);

    const res = echoing(4, OWNER);
    expect(validateResponseContext(res)).toBe(res);
    expect(hold).not.toHaveBeenCalled();
  });

  it("discards a response delayed across a switch, and enters the hold", () => {
    // Acceptance case 6: the response was already past the fence when the
    // switch committed, so the server served it honestly under the old context
    // and said so. The browser is on epoch 5 now.
    adoptRecordFenceState({ epoch: 5, scope: null });
    const hold = vi.fn();
    onRecordFenceMismatch(hold);

    expect(() => validateResponseContext(echoing(4, OWNER))).toThrow(
      RecordContextMismatchError,
    );
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it("discards on a matching epoch whose scope disagrees", () => {
    adoptRecordFenceState({ epoch: 4, scope: OWNER });
    const hold = vi.fn();
    onRecordFenceMismatch(hold);

    expect(() => validateResponseContext(echoing(4, "somebody-else"))).toThrow(
      RecordContextMismatchError,
    );
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it("serves an echoing response while still unadopted", () => {
    // Nothing to contradict: the request itself asserted `bootstrap`, so the
    // server already decided whether it could be served at all.
    const hold = vi.fn();
    onRecordFenceMismatch(hold);

    const res = echoing(0, null);
    expect(validateResponseContext(res)).toBe(res);
    expect(hold).not.toHaveBeenCalled();
  });

  it("does not raise an ApiError, because nothing about the exchange failed", () => {
    adoptRecordFenceState({ epoch: 5, scope: null });
    try {
      validateResponseContext(echoing(4, OWNER));
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RecordContextMismatchError);
      // A caller branching on `err.status` must not see a status that was
      // never refused — the response was a 200.
      expect((err as { status?: number }).status).toBeUndefined();
    }
  });

  it("releases the mismatch handler when its disposer runs", () => {
    adoptRecordFenceState({ epoch: 5, scope: null });
    const hold = vi.fn();
    const dispose = onRecordFenceMismatch(hold);
    dispose();

    expect(() => validateResponseContext(echoing(4, OWNER))).toThrow(
      RecordContextMismatchError,
    );
    expect(hold).not.toHaveBeenCalled();
  });
});
