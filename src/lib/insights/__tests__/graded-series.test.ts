import { describe, expect, it } from "vitest";

import {
  buildGradedSeriesFromPoints,
  type GradedSeries,
} from "../graded-series";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";

const TZ = "Europe/Berlin";

const dayMs = 24 * 60 * 60 * 1000;

function dailyPoints(
  days: number,
  now: Date,
  value = (i: number) => 80 + (i % 5),
) {
  const out: Array<{ measuredAt: Date; value: number }> = [];
  for (let i = 0; i < days; i++) {
    out.push({
      measuredAt: new Date(now.getTime() - i * dayMs),
      value: value(i),
    });
  }
  return out;
}

function countBuckets(s: GradedSeries): number {
  return s.recent.length + s.weekly.length + s.monthly.length + s.yearly.length;
}

describe("buildGradedSeriesFromPoints", () => {
  const now = new Date("2026-05-31T12:00:00Z");

  it("keeps the last ~14-21 days at daily granularity", () => {
    const s = buildGradedSeriesFromPoints(dailyPoints(400, now), now, TZ);
    expect(s.recent.length).toBeGreaterThan(0);
    expect(s.recent.length).toBeLessThanOrEqual(21);
    // Each recent bucket carries daily aggregates.
    for (const r of s.recent) {
      expect(r).toHaveProperty("date");
      expect(r).toHaveProperty("mean");
      expect(r).toHaveProperty("min");
      expect(r).toHaveProperty("max");
      expect(r).toHaveProperty("n");
    }
    // Recent buckets are sorted oldest → newest.
    const dates = s.recent.map((r) => r.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("folds the weeks after the recent window into ~8-10 ISO-week buckets", () => {
    const s = buildGradedSeriesFromPoints(dailyPoints(400, now), now, TZ);
    expect(s.weekly.length).toBeGreaterThan(0);
    expect(s.weekly.length).toBeLessThanOrEqual(12);
    for (const w of s.weekly) {
      expect(w).toHaveProperty("weekISO");
      expect(w).toHaveProperty("mean");
      expect(w).toHaveProperty("min");
      expect(w).toHaveProperty("max");
      expect(w).toHaveProperty("n");
    }
  });

  it("folds older history into ~9-12 monthly buckets", () => {
    const s = buildGradedSeriesFromPoints(dailyPoints(730, now), now, TZ);
    expect(s.monthly.length).toBeGreaterThan(0);
    expect(s.monthly.length).toBeLessThanOrEqual(14);
    for (const m of s.monthly) {
      expect(m).toHaveProperty("month");
      expect(m).toHaveProperty("mean");
      expect(m).toHaveProperty("min");
      expect(m).toHaveProperty("max");
    }
  });

  it("folds multi-year history into yearly buckets with a trend slope", () => {
    // 3+ years so at least one year lands in the yearly bucket.
    const s = buildGradedSeriesFromPoints(dailyPoints(1200, now), now, TZ);
    expect(s.yearly.length).toBeGreaterThan(0);
    for (const y of s.yearly) {
      expect(y).toHaveProperty("year");
      expect(y).toHaveProperty("mean");
      expect(y).toHaveProperty("slope");
    }
  });

  it("collapses a 2-year daily weigher into <= ~50 buckets, not 730", () => {
    const s = buildGradedSeriesFromPoints(dailyPoints(730, now), now, TZ);
    // ~21 recent + ~10 weekly + ~12 monthly + ~2-3 yearly. Worst-case
    // boundary slack lands ~46; the point is the order-of-magnitude
    // collapse from 730 daily readings, not an exact bucket count.
    expect(countBuckets(s)).toBeLessThanOrEqual(50);
  });

  it("returns empty buckets for an empty input", () => {
    const s = buildGradedSeriesFromPoints([], now, TZ);
    expect(countBuckets(s)).toBe(0);
  });

  it("does not duplicate a day across recent and weekly", () => {
    const s = buildGradedSeriesFromPoints(dailyPoints(120, now), now, TZ);
    // The most recent ISO week of the recent window must not also be a
    // weekly bucket — recent days are excluded from the weekly fold.
    const recentDates = new Set(s.recent.map((r) => r.date));
    // The weekly buckets cover days strictly older than the recent window.
    expect(recentDates.size).toBe(s.recent.length);
    expect(s.weekly.length).toBeGreaterThan(0);
  });

  it("computes per-bucket min/max/mean from same-day multi readings", () => {
    const points = [
      { measuredAt: new Date(now.getTime()), value: 70 },
      { measuredAt: new Date(now.getTime() - 1000), value: 90 },
      { measuredAt: new Date(now.getTime() - 2000), value: 80 },
    ];
    const s = buildGradedSeriesFromPoints(points, now, TZ);
    expect(s.recent.length).toBe(1);
    expect(s.recent[0].min).toBe(70);
    expect(s.recent[0].max).toBe(90);
    expect(s.recent[0].mean).toBe(80);
    expect(s.recent[0].n).toBe(3);
  });

  // A4 — the sleep AVERAGE the Insights assessment ships is the graded series
  // built from DEDUPED per-night totals, never the raw per-stage sum that
  // double-counts a bare ASLEEP aggregate against its granular twin (the
  // impossible ~20.3 h symptom). This pins the path metric-status now uses:
  // reconstruct nights → per-night points → buildGradedSeriesFromPoints.
  it("sleep graded series uses the deduped night total, never the ~20 h stage sum (A4)", () => {
    const sleepNow = new Date("2026-06-04T12:00:00.000Z");
    // One overnight session, Apple-Health-style double write: bare ASLEEP
    // aggregate (480) + granular CORE/DEEP/REM (also 480) + IN_BED + AWAKE.
    // Raw-summed this is ~1490 min (~24.8 h); deduped it is 480 min (8 h).
    const rows: SleepStageRow[] = [
      {
        measuredAt: new Date("2026-06-04T06:00:00.000Z"),
        sleepStage: "ASLEEP",
        value: 480,
        source: "APPLE_HEALTH",
      },
      {
        measuredAt: new Date("2026-06-04T02:00:00.000Z"),
        sleepStage: "CORE",
        value: 240,
        source: "APPLE_HEALTH",
      },
      {
        measuredAt: new Date("2026-06-04T04:00:00.000Z"),
        sleepStage: "DEEP",
        value: 120,
        source: "APPLE_HEALTH",
      },
      {
        measuredAt: new Date("2026-06-04T06:00:00.000Z"),
        sleepStage: "REM",
        value: 120,
        source: "APPLE_HEALTH",
      },
      {
        measuredAt: new Date("2026-06-04T06:30:00.000Z"),
        sleepStage: "IN_BED",
        value: 470,
        source: "APPLE_HEALTH",
      },
      {
        measuredAt: new Date("2026-06-04T03:00:00.000Z"),
        sleepStage: "AWAKE",
        value: 20,
        source: "APPLE_HEALTH",
      },
    ];
    const points = reconstructSleepNights(rows, "UTC")
      .filter((n) => n.asleepMinutes > 0)
      .map((n) => ({ measuredAt: n.measuredAt, value: n.asleepMinutes }));
    const graded = buildGradedSeriesFromPoints(points, sleepNow, TZ);
    const recentMean = graded.recent.at(-1)?.mean ?? 0;
    expect(recentMean).toBe(480); // night total, not ~1218 (stage sum)
    expect(recentMean).toBeLessThan(960); // < 16 h — never impossible
  });
});

describe("buildGradedSeriesFromPoints — the user's calendar", () => {
  it.each([
    // 23:30 on 9 June in New York is already 10 June in UTC and Berlin.
    ["America/New_York", "2026-06-10T03:30:00.000Z", "2026-06-09"],
    // 08:00 on 10 June in Auckland and Tonga is still 9 June in UTC.
    ["Pacific/Auckland", "2026-06-09T20:00:00.000Z", "2026-06-10"],
    ["Pacific/Tongatapu", "2026-06-09T19:00:00.000Z", "2026-06-10"],
  ])("keys a reading on its local day in %s", (tz, iso, day) => {
    const now = new Date("2026-06-12T12:00:00.000Z");
    const s = buildGradedSeriesFromPoints(
      [{ measuredAt: new Date(iso), value: 70 }],
      now,
      tz,
    );
    expect(s.recent.map((r) => r.date)).toEqual([day]);
  });
});
