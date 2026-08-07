/**
 * v1.37 — per-dimension staleness on the level-A blocks.
 *
 * The failure this exists to prevent has already happened once on the vitals
 * surfaces: a value was handed to the narrator with no notion of when it was
 * taken, and last week's reading came back as this morning's. The five
 * dimensions make that failure easier, not harder, because their ages differ
 * — somebody taps a face every morning and opens the detail sliders once a
 * week, so pleasantness is fresh while stress is six days old.
 *
 * The rule under test: every dimension carries its own age, and `current`
 * answers "may this back a present-tense sentence" through the one shared
 * freshness rule rather than through a comparison written here.
 */
import { describe, expect, it } from "vitest";

import { computeMoodDimensionSeries } from "@/lib/insights/mood-dimension-series";
import {
  TODAY_CLAIM_MAX_AGE_DAYS,
  isCurrentForTodayClaim,
} from "@/lib/insights/measurement-freshness";

const TODAY = "2026-08-08";

function dayKey(daysAgo: number): string {
  const d = new Date(Date.parse(`${TODAY}T00:00:00.000Z`));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** The shape `buildMoodDimensionFeatures` derives, without a database. */
function blocksFor(
  rows: Array<{ daysAgo: number; a1?: number; a2?: number }>,
): Array<{
  key: string;
  latest: number | null;
  newestDaysAgo: number | null;
  current: boolean;
}> {
  const summaries = computeMoodDimensionSeries(
    rows.map((r) => ({
      date: dayKey(r.daysAgo),
      a1: r.a1 ?? null,
      a2: r.a2 ?? null,
      a3: null,
      a4: null,
      a5: null,
    })),
    TODAY,
  );
  return summaries
    .filter((s) => s.present)
    .map((s) => ({
      key: s.key,
      latest: s.latest,
      newestDaysAgo: s.newestDaysAgo,
      current: isCurrentForTodayClaim(s.newestDaysAgo),
    }));
}

describe("level-A staleness", () => {
  it("calls this morning's pleasantness current and a five-day-old stress stale", () => {
    // The fixture the whole file is about: one entry today with a mood, one
    // five days ago that also answered stress.
    const blocks = blocksFor([
      { daysAgo: 0, a1: 8 },
      { daysAgo: 5, a1: 4, a2: 9 },
    ]);

    const a1 = blocks.find((b) => b.key === "a1")!;
    const a2 = blocks.find((b) => b.key === "a2")!;

    expect(a1.newestDaysAgo).toBe(0);
    expect(a1.current).toBe(true);

    expect(a2.latest).toBe(9);
    expect(a2.newestDaysAgo).toBe(5);
    // The claim under test: nothing may say "your stress is high today" from
    // this row. It is history and is stated with its date.
    expect(a2.current).toBe(false);
  });

  it("never carries a latest without an age beside it", () => {
    // The structural half of the fix. A `latest` alone is exactly what
    // produced the wrong sentence, so the shape is asserted, not the value.
    for (const block of blocksFor([{ daysAgo: 2, a1: 5, a2: 5 }])) {
      expect(block.latest).not.toBeNull();
      expect(block.newestDaysAgo).not.toBeNull();
      expect(typeof block.current).toBe("boolean");
    }
  });

  it("treats an unknown age as stale rather than as fresh", () => {
    // A missing age is not a fresh one. This is the shared rule's own
    // behaviour and is asserted here so a local reimplementation that
    // defaulted to `true` would be caught.
    expect(isCurrentForTodayClaim(null)).toBe(false);
    expect(isCurrentForTodayClaim(undefined)).toBe(false);
  });

  it("puts the boundary exactly where the shared rule puts it", () => {
    // Yesterday still backs a present claim; the day before does not. Read
    // off the exported constant rather than the literal 1, so a change to the
    // window moves this test with it instead of stranding it.
    const fresh = blocksFor([{ daysAgo: TODAY_CLAIM_MAX_AGE_DAYS, a1: 6 }]);
    expect(fresh[0].current).toBe(true);

    const stale = blocksFor([{ daysAgo: TODAY_CLAIM_MAX_AGE_DAYS + 1, a1: 6 }]);
    expect(stale[0].current).toBe(false);
  });
});
