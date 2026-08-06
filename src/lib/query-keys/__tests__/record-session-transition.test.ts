import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetRecordSessionTransitionForTests,
  beginRecordSessionTransition,
  commitRecordSessionTransition,
  getRecordSessionTransition,
  resolveUnknownRecordSessionTransition,
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
});
