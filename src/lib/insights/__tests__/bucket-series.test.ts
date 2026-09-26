import { describe, expect, it } from "vitest";

import {
  applyPayloadBudget,
  bucketSeries,
  dayOffsetToDayKey,
} from "../bucket-series";

const dayMs = 24 * 60 * 60 * 1000;

function pointsAtOffsets(
  now: Date,
  offsets: number[],
  value: number,
): Array<{ measuredAt: Date; value: number }> {
  return offsets.map((offset) => ({
    measuredAt: new Date(now.getTime() - offset * dayMs),
    value,
  }));
}

describe("bucketSeries()", () => {
  const now = new Date("2026-05-09T12:00:00Z");

  it("buckets the most recent dailyDays as daily means", () => {
    const records = pointsAtOffsets(now, [0, 0, 1, 1, 1, 5, 359], 100);
    const { daily, monthly } = bucketSeries(records, { now });

    // 4 distinct day offsets 0/1/5/359
    expect(daily.map((d) => d.dayOffset)).toEqual([0, 1, 5, 359]);
    expect(daily[0]).toEqual({ dayOffset: 0, value: 100, n: 2 });
    expect(daily[1]).toEqual({ dayOffset: 1, value: 100, n: 3 });
    expect(monthly).toHaveLength(0);
  });

  it("rolls older history into 30-day monthly buckets up to 36 months", () => {
    // dayOffset 360..1080 spans monthOffset 12..35 in the default config.
    const records = pointsAtOffsets(now, [360, 389, 390, 1079, 1080], 50);
    const { daily, monthly } = bucketSeries(records, { now });

    // Day 360 falls into the monthly window — daily empty.
    expect(daily).toHaveLength(0);
    // 360..389 → monthOffset 12, 390..419 → monthOffset 13,
    // 1050..1079 → monthOffset 35, 1080 → out of range.
    const offsets = monthly.map((m) => m.monthOffset);
    expect(offsets).toEqual([12, 13, 35]);
    // 360 and 389 collapse into one bucket
    expect(monthly[0].n).toBe(2);
  });

  it("skips empty buckets entirely", () => {
    const records = pointsAtOffsets(now, [0, 720], 1);
    const { daily, monthly } = bucketSeries(records, { now });
    expect(daily).toHaveLength(1);
    expect(monthly).toHaveLength(1);
  });

  it("ignores future timestamps", () => {
    const records = [
      { measuredAt: new Date(now.getTime() + dayMs), value: 5 },
      { measuredAt: now, value: 5 },
    ];
    const { daily } = bucketSeries(records, { now });
    expect(daily).toHaveLength(1);
    expect(daily[0].dayOffset).toBe(0);
  });

  it("monthOffset labelling is stable regardless of dailyDays", () => {
    // With dailyDays=180, monthOffsetBase shifts to 6.
    const records = pointsAtOffsets(now, [180, 209, 210], 1);
    const { daily, monthly } = bucketSeries(records, { now, dailyDays: 180 });
    expect(daily).toHaveLength(0);
    expect(monthly[0].monthOffset).toBe(6);
    expect(monthly[1].monthOffset).toBe(7);
  });
});

describe("dayOffsetToDayKey() across DST boundaries", () => {
  // Europe/Berlin DST in 2024: spring-forward at 2024-03-31 02:00 → 03:00,
  // fall-back at 2024-10-27 03:00 → 02:00. Naive `now − dayOffset·86_400_000`
  // would crawl past those boundaries by an hour and silently land on the
  // wrong calendar day for ~2 days/year. The helper must treat dayOffset
  // as CALENDAR days, not 24-hour ticks.

  it("produces today's Berlin date for dayOffset 0 around the spring-forward", () => {
    // 2024-03-31 11:30 Berlin (= 09:30 UTC, after the gap).
    const now = new Date("2024-03-31T09:30:00.000Z");
    expect(dayOffsetToDayKey(now, 0)).toBe("2024-03-31");
    expect(dayOffsetToDayKey(now, 1)).toBe("2024-03-30");
  });

  it("crossing the spring-forward DST boundary stays on the correct Berlin calendar day", () => {
    // April 2 11:30 Berlin → 09:30 UTC (post-DST CEST).
    const now = new Date("2024-04-02T09:30:00.000Z");
    // Naive subtraction (now − 3·86_400_000) = 2024-03-30T09:30:00 UTC →
    // 11:30 CET → still 2024-03-30. That happens to look right here, so
    // the killer case is dayOffset 2 from a moment LATE on the day before
    // the gap.
    expect(dayOffsetToDayKey(now, 0)).toBe("2024-04-02");
    expect(dayOffsetToDayKey(now, 1)).toBe("2024-04-01");
    expect(dayOffsetToDayKey(now, 2)).toBe("2024-03-31");
    expect(dayOffsetToDayKey(now, 3)).toBe("2024-03-30");
  });

  it("crossing the spring-forward boundary from late-evening Berlin time does not slip a day", () => {
    // 2024-04-01 00:30 Berlin (= 2024-03-31 22:30 UTC, in CEST). Naive
    // (now − 1·86_400_000) lands at 2024-03-30 22:30 UTC = 2024-03-30
    // 23:30 CET, which Intl formats as 2024-03-30. The CALENDAR-day
    // answer is 2024-03-31 — one Berlin calendar day earlier than today.
    const now = new Date("2024-03-31T22:30:00.000Z");
    expect(dayOffsetToDayKey(now, 0)).toBe("2024-04-01");
    expect(dayOffsetToDayKey(now, 1)).toBe("2024-03-31");
    expect(dayOffsetToDayKey(now, 2)).toBe("2024-03-30");
  });

  it("crossing the fall-back boundary from late-evening Berlin time does not slip a day", () => {
    // 2024-10-28 00:30 Berlin (CET, post-fall-back) = 2024-10-27 23:30 UTC.
    // Naive (now − 1·86_400_000) = 2024-10-26 23:30 UTC, which Intl
    // formats with timeZone Europe/Berlin (still CEST!) as 2024-10-27
    // 01:30 → 2024-10-27. That's actually correct by coincidence, so we
    // probe the dayOffset where the bias bites:
    const now = new Date("2024-10-27T23:30:00.000Z");
    expect(dayOffsetToDayKey(now, 0)).toBe("2024-10-28");
    expect(dayOffsetToDayKey(now, 1)).toBe("2024-10-27");
    expect(dayOffsetToDayKey(now, 2)).toBe("2024-10-26");
  });

  it("crossing the fall-back boundary the other direction (early-morning) stays put", () => {
    // 2024-10-27 02:30 Berlin AFTER the fall-back = 02:30 CET = 01:30 UTC.
    // dayOffset 1 should be 2024-10-26 (calendar), not 2024-10-25 (which
    // is what naive 24h subtraction gives because the day was 25 hours
    // long).
    const now = new Date("2024-10-27T01:30:00.000Z");
    expect(dayOffsetToDayKey(now, 0)).toBe("2024-10-27");
    expect(dayOffsetToDayKey(now, 1)).toBe("2024-10-26");
    expect(dayOffsetToDayKey(now, 7)).toBe("2024-10-20");
  });
});

describe("bucketSeries() honours the per-user timezone (M-TZ3)", () => {
  // A reading at 23:30 in America/Los_Angeles (PDT, UTC-7) on 2026-05-09 is
  // already 08:30 on 2026-05-10 in Europe/Berlin (CEST, UTC+2). The same
  // raw instant therefore lands on a different calendar day — and a
  // different `dayOffset` — depending on which timezone the buckets key in.
  const reading = new Date("2026-05-10T06:30:00.000Z"); // LA 05-09 23:30
  const now = new Date("2026-05-10T20:00:00.000Z"); // LA 05-10 13:00

  it("buckets a near-midnight reading on the user's LOCAL day for LA", () => {
    const { daily } = bucketSeries([{ measuredAt: reading, value: 42 }], {
      now,
      tz: "America/Los_Angeles",
    });
    // LA: now is 05-10, reading is 05-09 → one local day ago.
    expect(daily).toHaveLength(1);
    expect(daily[0].dayOffset).toBe(1);
  });

  it("gives a DIFFERENT dayOffset for the same reading under Berlin", () => {
    const { daily } = bucketSeries([{ measuredAt: reading, value: 42 }], {
      now,
      tz: "Europe/Berlin",
    });
    // Berlin: both now and reading fall on 05-10 → same local day (offset 0).
    expect(daily).toHaveLength(1);
    expect(daily[0].dayOffset).toBe(0);
  });

  it("leaves a Berlin user's bucketing identical to the default", () => {
    const records = pointsAtOffsets(now, [0, 1, 5], 100).concat([
      { measuredAt: reading, value: 42 },
    ]);
    const def = bucketSeries(records, { now });
    const berlin = bucketSeries(records, { now, tz: "Europe/Berlin" });
    expect(berlin).toEqual(def);
  });

  it("dayOffsetToDayKey resolves the offset in the passed timezone", () => {
    // `now` is 05-09 in LA but 05-10 in Berlin.
    expect(dayOffsetToDayKey(reading, 0, "America/Los_Angeles")).toBe(
      "2026-05-09",
    );
    // Default (no tz) and explicit Berlin agree.
    expect(dayOffsetToDayKey(reading, 0)).toBe("2026-05-10");
    expect(dayOffsetToDayKey(reading, 0, "Europe/Berlin")).toBe("2026-05-10");
  });

  it("applyPayloadBudget threads the timezone through to the buckets", () => {
    const la = applyPayloadBudget([{ measuredAt: reading, value: 42 }], {
      now,
      tz: "America/Los_Angeles",
    });
    const berlin = applyPayloadBudget([{ measuredAt: reading, value: 42 }], {
      now,
      tz: "Europe/Berlin",
    });
    expect(la.daily[0].dayOffset).toBe(1);
    expect(berlin.daily[0].dayOffset).toBe(0);
  });
});

describe("applyPayloadBudget()", () => {
  const now = new Date("2026-05-09T12:00:00Z");

  it("returns the canonical 360+24 bucketing when payload is small", () => {
    const records = pointsAtOffsets(now, [0, 1, 2], 100);
    const result = applyPayloadBudget(records, { now });
    expect(result.daily).toHaveLength(3);
  });

  it("falls back to 180 daily days when the canonical payload exceeds the byte budget", () => {
    // Synthesise enough records to bloat the canonical payload past 1 KB
    // (test budget). 360 unique daily offsets each with 30 samples will
    // serialise to ~30 KB in canonical form.
    const offsets: number[] = [];
    for (let day = 0; day < 360; day++) {
      for (let i = 0; i < 30; i++) offsets.push(day);
    }
    const records = pointsAtOffsets(now, offsets, 12.5);
    const result = applyPayloadBudget(records, { now }, 1_000);
    // Daily window must have shrunk to 180 buckets at most.
    expect(result.daily.length).toBeLessThanOrEqual(180);
  });
});
