/**
 * A `@/lib/feature-flags` mock whose two readers can never disagree.
 *
 * The module has two readers of the operator's assistant switches:
 * `getAssistantFlags()`, which the crons and a few routes read directly, and
 * `loadAssistantSwitches()`, which the AI capability loader reads. A mock that
 * stubs only the first leaves the second undefined, the loader throws, and
 * every capability resolves to `check_failed`. Nothing goes red: a test that
 * meant "AI on" quietly runs the "AI unavailable" branch instead, and a test
 * that meant "AI off for reason X" passes for reason `check_failed`.
 *
 * So both readers answer from one source. Hand the factory the function the
 * test already drives (or let it make one), and `loadAssistantSwitches` reads
 * whatever that function currently returns:
 *
 * ```ts
 * const getAssistantFlags = vi.fn();
 * vi.mock("@/lib/feature-flags", async () =>
 *   (await import("@/__tests__/helpers/assistant-switches-mock"))
 *     .mockAssistantSwitches((...a) => getAssistantFlags(...a)),
 * );
 * ```
 *
 * `loadAssistantSwitches` is a plain function, not a `vi.fn`, so a
 * `vi.resetAllMocks()` in the test cannot strip it back to `undefined`.
 * `src/__tests__/feature-flags-mock-guard.test.ts` refuses a
 * `vi.mock("@/lib/feature-flags", …)` that provides neither this helper nor
 * `loadAssistantSwitches` by name.
 */
import { vi } from "vitest";

import type { AssistantFlagSet } from "@/lib/feature-flags";

/** Every switch on: what a fresh install reads. */
export const ALL_SWITCHES_ON: AssistantFlagSet = Object.freeze({
  enabled: true,
  coach: true,
  briefing: true,
  insightStatus: true,
  documentAi: true,
});

/** Every switch off, as an operator who turned the assistant off has it. */
export const ALL_SWITCHES_OFF: AssistantFlagSet = Object.freeze({
  enabled: false,
  coach: false,
  briefing: false,
  insightStatus: false,
  documentAi: false,
});

type SwitchReader = (...args: never[]) => unknown | Promise<unknown>;

export function mockAssistantSwitches(
  getAssistantFlags: SwitchReader = vi.fn(async () => ({
    ...ALL_SWITCHES_ON,
  })),
) {
  return {
    getAssistantFlags,
    loadAssistantSwitches: async () => getAssistantFlags(),
  };
}
