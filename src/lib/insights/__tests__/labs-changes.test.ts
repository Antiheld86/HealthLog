import { describe, it, expect } from "vitest";

import {
  LAB_CHANGE_RECENCY_DAYS,
  summariseLabChanges,
  type LabChangeRow,
} from "@/lib/insights/labs-changes";

/**
 * Every case pins `now`. The fixtures are fixed calendar days and the summary
 * has a relative freshness window, so a floating `new Date()` would leave the
 * pairing case green until the day it silently slid out of the window and then
 * fail for a reason that has nothing to do with the code under test.
 */
const NOW = new Date("2026-06-15T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function row(
  analyte: string,
  value: number,
  day: string,
  opts: {
    unit?: string;
    low?: number | null;
    high?: number | null;
    sourceLow?: number | null;
    sourceHigh?: number | null;
    sourceText?: string | null;
  } = {},
): LabChangeRow {
  return {
    analyte,
    unit: opts.unit ?? "mg/dL",
    value,
    referenceLow: opts.low ?? null,
    referenceHigh: opts.high ?? null,
    sourceReferenceLow: opts.sourceLow ?? null,
    sourceReferenceHigh: opts.sourceHigh ?? null,
    sourceReferenceText: opts.sourceText ?? null,
    takenAt: new Date(`${day}T08:00:00.000Z`),
  };
}

describe("summariseLabChanges", () => {
  it("is absent with no rows", () => {
    expect(summariseLabChanges([], NOW)).toMatchObject({ present: false });
  });

  it("is absent with a single panel", () => {
    const s = summariseLabChanges([row("LDL", 130, "2026-06-01")], NOW);
    expect(s.present).toBe(false);
  });

  it("is absent when no analyte is shared across panels", () => {
    const s = summariseLabChanges(
      [row("LDL", 130, "2026-06-01"), row("HbA1c", 5.4, "2026-05-01")],
      NOW,
    );
    expect(s.present).toBe(false);
  });

  it("pairs the two most-recent panels for a shared analyte", () => {
    const s = summariseLabChanges(
      [
        row("LDL", 120, "2026-06-01", { high: 116 }),
        row("LDL", 140, "2026-05-01"),
        row("LDL", 150, "2026-04-01"),
      ],
      NOW,
    );
    expect(s.present).toBe(true);
    expect(s.latestDate).toBe("2026-06-01");
    expect(s.previousDate).toBe("2026-05-01");
    expect(s.changes).toHaveLength(1);
    const c = s.changes[0];
    expect(c.latest).toBe(120);
    expect(c.previous).toBe(140);
    expect(c.delta).toBe(-20);
    expect(c.direction).toBe("down");
    expect(c.status).toBe("above");
  });

  it("skips qualitative (non-finite) values", () => {
    const s = summariseLabChanges(
      [row("LDL", Number.NaN, "2026-06-01"), row("LDL", 140, "2026-05-01")],
      NOW,
    );
    expect(s.present).toBe(false);
  });

  // The comparison is a claim about what changed "since your last panel". Past
  // the window that sentence is no longer true of anybody's data, so the
  // summary reports absent rather than presenting a years-old delta as news.
  it("is present while the newest panel is inside the recency window", () => {
    const latest = new Date(
      NOW.getTime() - (LAB_CHANGE_RECENCY_DAYS - 1) * DAY_MS,
    );
    const previous = new Date(latest.getTime() - 30 * DAY_MS);
    const s = summariseLabChanges(
      [
        { ...row("LDL", 120, "2026-01-01"), takenAt: latest },
        { ...row("LDL", 140, "2026-01-01"), takenAt: previous },
      ],
      NOW,
    );
    expect(s.present).toBe(true);
    expect(s.changes).toHaveLength(1);
  });

  it("is absent once the newest panel falls outside it", () => {
    const latest = new Date(
      NOW.getTime() - (LAB_CHANGE_RECENCY_DAYS + 1) * DAY_MS,
    );
    const previous = new Date(latest.getTime() - 30 * DAY_MS);
    const s = summariseLabChanges(
      [
        { ...row("LDL", 120, "2026-01-01"), takenAt: latest },
        { ...row("LDL", 140, "2026-01-01"), takenAt: previous },
      ],
      NOW,
    );
    expect(s.present).toBe(false);
    expect(s.changes).toEqual([]);
    expect(s.latestDate).toBeNull();
  });

  // The boundary is read off the sample instant, not off the UTC day key: a
  // panel drawn in the evening east of UTC keys to the NEXT calendar day, and
  // re-parsing that key would move the cut-off by hours in one direction and
  // hours the other way for anyone west of it.
  it("measures the window from the sample instant, not the calendar-day key", () => {
    const latest = new Date(
      NOW.getTime() - LAB_CHANGE_RECENCY_DAYS * DAY_MS + 60_000,
    );
    const previous = new Date(latest.getTime() - 30 * DAY_MS);
    const s = summariseLabChanges(
      [
        { ...row("LDL", 120, "2026-01-01"), takenAt: latest },
        { ...row("LDL", 140, "2026-01-01"), takenAt: previous },
      ],
      NOW,
    );
    expect(s.present).toBe(true);
  });
});
