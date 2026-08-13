import { describe, it, expect } from "vitest";

/**
 * Refs #786 — the async-truth contract for the force regenerate.
 *
 * A regenerate the client gives up on at 45 s is NOT a failure: the server's
 * inline generation keeps running and usually writes the cache moments later.
 * The old behaviour fired an error toast and then never converged (staleTime
 * 1 h + focus refetch off), so the page kept showing the old assessment while
 * claiming the refresh failed. The fix enters a "settling" state: remember
 * the baseline `cachedAt`, keep polling on the existing bounded cadence, and
 * resolve to a REAL outcome — fresh (cache advanced), settle-failed (a newer
 * failure marker, or the attempt cap).
 *
 * Two pure seams pin the state machine:
 *   - `nextAdvisorPollInterval` gains settling as the second poll reason,
 *     with attempts counted from the settle start.
 *   - `resolveAdvisorSettle` decides fresh / settle-failed / keep-waiting.
 */

import {
  ADVISOR_REVALIDATE_POLL_MAX_ATTEMPTS,
  ADVISOR_REVALIDATE_POLL_MS,
  nextAdvisorPollInterval,
  resolveAdvisorSettle,
  type AdvisorSettleState,
} from "../use-insights-advisor";

function settle(
  overrides: Partial<AdvisorSettleState> = {},
): AdvisorSettleState {
  return {
    baselineCachedAt: "2026-08-13T06:00:00.000Z",
    baselineFailed: false,
    startedAtUpdateCount: 4,
    ...overrides,
  };
}

describe("nextAdvisorPollInterval — settling is the second poll reason (#786)", () => {
  it("polls while settling even when nothing reports revalidating", () => {
    expect(nextAdvisorPollInterval(false, 5, settle())).toBe(
      ADVISOR_REVALIDATE_POLL_MS,
    );
    expect(nextAdvisorPollInterval(undefined, 5, settle())).toBe(
      ADVISOR_REVALIDATE_POLL_MS,
    );
  });

  it("counts settling attempts from the settle start, not from mount", () => {
    // 12 data updates total but only 8 since settling began → keep polling.
    expect(
      nextAdvisorPollInterval(false, 12, settle({ startedAtUpdateCount: 4 })),
    ).toBe(ADVISOR_REVALIDATE_POLL_MS);
  });

  it("stops at the settling attempt ceiling", () => {
    expect(
      nextAdvisorPollInterval(
        false,
        4 + ADVISOR_REVALIDATE_POLL_MAX_ATTEMPTS,
        settle({ startedAtUpdateCount: 4 }),
      ),
    ).toBe(false);
  });

  it("keeps the pre-existing revalidating behaviour when not settling", () => {
    expect(nextAdvisorPollInterval(true, 1, null)).toBe(
      ADVISOR_REVALIDATE_POLL_MS,
    );
    expect(nextAdvisorPollInterval(false, 1, null)).toBe(false);
    expect(nextAdvisorPollInterval(true, 1)).toBe(ADVISOR_REVALIDATE_POLL_MS);
  });
});

describe("resolveAdvisorSettle — the settle state machine (#786)", () => {
  it("resolves fresh once cachedAt advances past the baseline", () => {
    expect(
      resolveAdvisorSettle(
        settle(),
        { cachedAt: "2026-08-13T06:02:31.000Z", generationFailed: false },
        6,
      ),
    ).toBe("fresh");
  });

  it("resolves fresh on ANY cachedAt when there was no baseline (first generation)", () => {
    expect(
      resolveAdvisorSettle(
        settle({ baselineCachedAt: null }),
        { cachedAt: "2026-08-13T06:02:31.000Z", generationFailed: false },
        6,
      ),
    ).toBe("fresh");
  });

  it("keeps waiting while the cache is unchanged and attempts remain", () => {
    expect(
      resolveAdvisorSettle(
        settle(),
        { cachedAt: "2026-08-13T06:00:00.000Z", generationFailed: false },
        6,
      ),
    ).toBe(null);
  });

  it("resolves settle-failed on a NEWER failure marker (failed flipped during settling)", () => {
    expect(
      resolveAdvisorSettle(
        settle({ baselineFailed: false }),
        { cachedAt: "2026-08-13T06:00:00.000Z", generationFailed: true },
        6,
      ),
    ).toBe("settle-failed");
  });

  it("does NOT treat a failure marker that predates the settle as fresh evidence", () => {
    // The baseline already carried the failed flag — an unchanged flag says
    // nothing about THIS generation; keep waiting for cachedAt or the cap.
    expect(
      resolveAdvisorSettle(
        settle({ baselineFailed: true }),
        { cachedAt: "2026-08-13T06:00:00.000Z", generationFailed: true },
        6,
      ),
    ).toBe(null);
  });

  it("resolves settle-failed at the attempt cap — never waits forever", () => {
    expect(
      resolveAdvisorSettle(
        settle({ startedAtUpdateCount: 4 }),
        { cachedAt: "2026-08-13T06:00:00.000Z", generationFailed: false },
        4 + ADVISOR_REVALIDATE_POLL_MAX_ATTEMPTS,
      ),
    ).toBe("settle-failed");
  });

  it("a missing payload keeps waiting (no evidence either way)", () => {
    expect(resolveAdvisorSettle(settle(), null, 6)).toBe(null);
    expect(resolveAdvisorSettle(settle(), undefined, 6)).toBe(null);
  });
});
