import { describe, it, expect } from "vitest";

import { interruptedResumeValue } from "../use-coach";

/**
 * #781 — the write side of the interrupted-conversation resume. The unmount
 * cleanup records `interruptedResumeValue(...)` under
 * `COACH_INTERRUPTED_STORAGE_KEY` before aborting an in-flight stream; the
 * `/coach` page's consumption side is pinned in
 * `src/app/coach/__tests__/page-interrupted-resume.test.tsx`.
 */
describe("interruptedResumeValue (#781)", () => {
  it("records the conversation id for an in-flight turn on an existing thread", () => {
    expect(
      interruptedResumeValue({ conversationId: "conv-42", inProgress: true }),
    ).toBe("conv-42");
  });

  it("records the 'latest' sentinel for an in-flight FIRST turn (id unknown)", () => {
    expect(
      interruptedResumeValue({ conversationId: null, inProgress: true }),
    ).toBe("latest");
  });

  it("records nothing for a settled turn — unmount after completion is not an interruption", () => {
    expect(
      interruptedResumeValue({ conversationId: "conv-42", inProgress: false }),
    ).toBe(null);
    expect(
      interruptedResumeValue({ conversationId: null, inProgress: false }),
    ).toBe(null);
  });
});
