import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetRecordSessionTransitionForTests,
  beginRecordSessionTransition,
  commitRecordSessionTransition,
  getRecordSessionTransition,
  resolveUnknownRecordSessionTransition,
  isForeignScopeWrite,
  settleRefusedRecordSessionTransition,
  settleRecordSessionTransition,
} from "@/lib/query-keys/record-session-transition";
import {
  __resetRecordScopeForTests,
  getRecordScope,
  setRecordScope,
} from "@/lib/query-keys/record-scope";

beforeEach(() => {
  __resetRecordScopeForTests();
  __resetRecordSessionTransitionForTests();
});

describe("record session transition", () => {
  it("blocks every tab before the server switch starts", () => {
    setRecordScope(null);

    const transitionId = beginRecordSessionTransition("shared-record");

    expect(getRecordSessionTransition()).toMatchObject({
      id: transitionId,
      phase: "blocking",
      expectedScope: "shared-record",
    });
    expect(getRecordScope()).toBeNull();
  });

  it("keeps the hold through the committed scope until /me confirms it", () => {
    const transitionId = beginRecordSessionTransition("shared-record");

    commitRecordSessionTransition(transitionId, "shared-record");

    expect(getRecordScope()).toBe("shared-record");
    expect(getRecordSessionTransition()).toMatchObject({
      id: transitionId,
      phase: "resolving",
      expectedScope: "shared-record",
    });

    settleRecordSessionTransition("shared-record");

    expect(getRecordSessionTransition().phase).toBe("ready");
  });

  it("keeps a failed switch held until /me reconciles the prior scope", () => {
    setRecordScope(null);
    const transitionId = beginRecordSessionTransition("shared-record");

    resolveUnknownRecordSessionTransition(transitionId);

    expect(getRecordSessionTransition()).toMatchObject({
      id: transitionId,
      phase: "resolving",
      expectedScope: undefined,
    });
    expect(getRecordScope()).toBeNull();

    settleRecordSessionTransition(null);

    expect(getRecordSessionTransition().phase).toBe("ready");
  });

  it("does not release a committed transition for a divergent /me response", () => {
    const transitionId = beginRecordSessionTransition("shared-record");
    commitRecordSessionTransition(transitionId, "shared-record");

    settleRecordSessionTransition("different-record");

    expect(getRecordSessionTransition()).toMatchObject({
      phase: "resolving",
      expectedScope: "shared-record",
    });
  });

  it("releases an explicitly refused /me response without trusting a scope", () => {
    const transitionId = beginRecordSessionTransition("shared-record");
    commitRecordSessionTransition(transitionId, "shared-record");

    settleRefusedRecordSessionTransition();

    expect(getRecordSessionTransition()).toEqual({
      id: transitionId,
      phase: "ready",
      expectedScope: undefined,
    });
  });

  // ── The scope mirror is not a foreign switch ─────────────────────────────
  //
  // The listener that watches the scope mirror catches a switch this browser
  // did not begin. It recognised its OWN by comparing the mirrored scope
  // against `expectedScope`, which is not a true test: `fetchMe()` mirrors
  // whatever record the server currently reports and it runs during a switch —
  // `postSwitchWithReconcile` calls it to reconcile a lost compare-and-set, and
  // a peer tab reloading beside the initiator calls it too. At that moment the
  // server still reports the record being left, so the write did not match and
  // was read as foreign.
  //
  // The consequence is silent and total. A foreign write publishes a NEW id,
  // and every terminal call opens with `if (transition.id !== id) return`, so
  // the commit that follows is dropped without a trace and `expectedScope` is
  // left naming a record no `/me` will confirm. Both tabs then sit behind the
  // hydration gate until the stored transition ages out thirty seconds later.
  //
  // The rule is extracted rather than driven through a StorageEvent because
  // this suite runs in `node`: with no `window` the listener never attaches,
  // so a DOM-shaped test here would pass without exercising anything.

  it("treats a scope write as foreign only when nothing of ours is in flight", () => {
    expect(
      isForeignScopeWrite({
        id: null,
        phase: "ready",
        expectedScope: undefined,
      }),
    ).toBe(true);
  });

  it("does not treat its own in-flight switch as a foreign write", () => {
    // Both non-ready phases, each with an `expectedScope` that does NOT match
    // what a reconcile mirrors — the exact combination the old comparison got
    // wrong.
    expect(
      isForeignScopeWrite({
        id: "t1",
        phase: "blocking",
        expectedScope: "shared-record",
      }),
    ).toBe(false);
    expect(
      isForeignScopeWrite({
        id: "t1",
        phase: "resolving",
        expectedScope: "shared-record",
      }),
    ).toBe(false);
  });

  it("does not treat an outcome-unknown hold as a foreign write either", () => {
    // `resolveUnknownRecordSessionTransition` leaves `expectedScope`
    // undefined, which never matched a mirrored scope, so under the old
    // comparison every scope write during that hold reassigned the id.
    expect(
      isForeignScopeWrite({
        id: "t1",
        phase: "resolving",
        expectedScope: undefined,
      }),
    ).toBe(false);
  });

  it("keeps a commit landing on the transition it was issued for", () => {
    // The end-to-end shape without the DOM: the id must not move between
    // begin and commit, or the commit is dropped and no `/me` releases.
    const transitionId = beginRecordSessionTransition("shared-record");
    expect(getRecordSessionTransition().id).toBe(transitionId);

    commitRecordSessionTransition(transitionId, "shared-record");
    expect(getRecordSessionTransition()).toMatchObject({
      phase: "resolving",
      expectedScope: "shared-record",
    });

    settleRecordSessionTransition("shared-record");
    expect(getRecordSessionTransition().phase).toBe("ready");
  });

  it("still refuses to release on a scope the transition did not expect", () => {
    // The property the guard exists for, pinned so the change above cannot be
    // read as permission to release on anything: a `/me` that disagrees with a
    // COMMITTED scope is stale and must not release.
    const transitionId = beginRecordSessionTransition("shared-record");
    commitRecordSessionTransition(transitionId, "shared-record");

    settleRecordSessionTransition(null);
    expect(getRecordSessionTransition().phase).toBe("resolving");
  });
});
