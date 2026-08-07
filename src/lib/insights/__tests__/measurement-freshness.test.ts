/**
 * A reading from five days ago must not produce a sentence about today.
 *
 * Two surfaces said it out loud — the day-signals card ("one of your vitals is
 * outside its usual range today") and the baseline-drift card ("your pulse is
 * above your usual range") — and the narrated hero line said it in prose. One
 * class: the freshest stored reading reached each of them with no notion of
 * when it was taken, so every one of them assumed now.
 *
 * These cover the shared rule and the two deterministic consumers. The
 * narrated surfaces are covered by the snapshot stamp beside them.
 */
import { describe, expect, it } from "vitest";

import {
  TODAY_CLAIM_MAX_AGE_DAYS,
  dayKeyAgeInDays,
  isCurrentForTodayClaim,
} from "../measurement-freshness";
import { summariseHealthStatus } from "../health-status";
import { classifyDeviation } from "../derived/coincident-deviation";
import {
  annotateSnapshotFreshness,
  asOfFromDaysAgo,
} from "@/lib/ai/coach/snapshot-freshness";

describe("the today-claim window", () => {
  it("admits today and yesterday and refuses anything older", () => {
    expect(isCurrentForTodayClaim(0)).toBe(true);
    expect(isCurrentForTodayClaim(TODAY_CLAIM_MAX_AGE_DAYS)).toBe(true);
    expect(isCurrentForTodayClaim(TODAY_CLAIM_MAX_AGE_DAYS + 1)).toBe(false);
    expect(isCurrentForTodayClaim(5)).toBe(false);
  });

  it("treats an unknown age as not current", () => {
    expect(isCurrentForTodayClaim(null)).toBe(false);
    expect(isCurrentForTodayClaim(undefined)).toBe(false);
    expect(isCurrentForTodayClaim(Number.NaN)).toBe(false);
    expect(isCurrentForTodayClaim(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isCurrentForTodayClaim(-1)).toBe(false);
  });

  it("counts whole calendar days between two local day keys", () => {
    expect(dayKeyAgeInDays("2026-08-07", "2026-08-07")).toBe(0);
    expect(dayKeyAgeInDays("2026-08-06", "2026-08-07")).toBe(1);
    expect(dayKeyAgeInDays("2026-08-02", "2026-08-07")).toBe(5);
    // Across a month end and across a DST change in the reader's zone.
    expect(dayKeyAgeInDays("2026-07-31", "2026-08-07")).toBe(7);
    expect(dayKeyAgeInDays("2026-10-24", "2026-10-26")).toBe(2);
    expect(dayKeyAgeInDays("not-a-day", "2026-08-07")).toBeNull();
  });
});

describe("the baseline-drift card's deviations", () => {
  /** A pulse well above its band, taken `daysAgo` days ago. */
  const raisedPulse = (daysAgo: number) =>
    classifyDeviation("PULSE", 96, 58, 74, 66, daysAgo);

  it("carries a deviation measured today", () => {
    const summary = summariseHealthStatus([raisedPulse(0)], []);

    expect(summary.present).toBe(true);
    expect(summary.deviations.map((d) => d.type)).toEqual(["PULSE"]);
  });

  it("says nothing about a vital last measured five days ago", () => {
    const summary = summariseHealthStatus([raisedPulse(5)], []);

    expect(summary.deviations).toEqual([]);
    expect(summary.present).toBe(false);
  });

  it("keeps a dated level shift, which was never a today claim", () => {
    const summary = summariseHealthStatus(
      [raisedPulse(5)],
      [
        {
          metric: "RESTING_HEART_RATE",
          breakDate: "2026-07-20",
          beforeMean: 54,
          afterMean: 61,
          direction: "up",
          magnitude: 2.1,
        },
      ],
    );

    expect(summary.deviations).toEqual([]);
    expect(summary.shifts).toHaveLength(1);
    expect(summary.present).toBe(true);
  });
});

describe("the Coach snapshot stamp", () => {
  it("states the age and the consequence on the block itself", () => {
    expect(asOfFromDaysAgo(0)).toEqual({
      daysAgo: 0,
      isToday: true,
      currentForTodayClaims: true,
    });
    expect(asOfFromDaysAgo(5)).toEqual({
      daysAgo: 5,
      isToday: false,
      currentForTodayClaims: false,
    });
  });

  it("stamps every metric block and names the stale ones", () => {
    const snapshot: Record<string, unknown> = {
      pulse: {
        aggregate: { avg30: 66, coverage: { count: 40, newestDaysAgo: 5 } },
        timeline: { recent: [] },
      },
      weight: {
        aggregate: { latest: 81.4, coverage: { count: 30, newestDaysAgo: 0 } },
      },
      // No measurement to date — untouched.
      memory: { headline: "steady month" },
      scope: { sources: ["pulse", "weight"] },
    };

    const stale = annotateSnapshotFreshness(snapshot);

    expect(stale).toEqual(["pulse"]);
    expect((snapshot.pulse as { asOf: unknown }).asOf).toEqual({
      daysAgo: 5,
      isToday: false,
      currentForTodayClaims: false,
    });
    expect((snapshot.weight as { asOf: unknown }).asOf).toEqual({
      daysAgo: 0,
      isToday: true,
      currentForTodayClaims: true,
    });
    expect(snapshot.memory).toEqual({ headline: "steady month" });
    expect(snapshot.scope).toEqual({ sources: ["pulse", "weight"] });
  });
});
