import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.15 Fix 3: the mood chart used to render raw daily points only
 * regardless of window length, while every other dashboard chart
 * (BP, weight, pulse) auto-aggregated to weekly / monthly when the
 * visible range got long. The aggregation helpers + chip are
 * exported so the contract can be locked in unit tests.
 */

import { aggregateMoodEntries, pickMoodBucket, MoodChart } from "../mood-chart";

function dayEntries(
  start: string,
  count: number,
  score = 4,
): Array<{
  date: string;
  score: number;
}> {
  const [y, m, d] = start.split("-").map(Number);
  const out: Array<{ date: string; score: number }> = [];
  for (let i = 0; i < count; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    out.push({ date: `${yy}-${mm}-${dd}`, score });
  }
  return out;
}

describe("pickMoodBucket()", () => {
  it("returns 'day' for short windows (<= 90 days)", () => {
    expect(pickMoodBucket(dayEntries("2026-01-01", 7))).toBe("day");
    expect(pickMoodBucket(dayEntries("2026-01-01", 30))).toBe("day");
    expect(pickMoodBucket(dayEntries("2026-01-01", 91))).toBe("day"); // 90-day span
  });

  it("returns 'week' for windows 91-730 days", () => {
    expect(pickMoodBucket(dayEntries("2026-01-01", 92))).toBe("week");
    expect(pickMoodBucket(dayEntries("2026-01-01", 365))).toBe("week");
    expect(pickMoodBucket(dayEntries("2026-01-01", 731))).toBe("week"); // 730-day span
  });

  it("returns 'month' for windows > 730 days", () => {
    expect(pickMoodBucket(dayEntries("2024-01-01", 800))).toBe("month");
    expect(pickMoodBucket(dayEntries("2020-01-01", 1500))).toBe("month");
  });

  it("returns 'day' for empty / single-point series", () => {
    expect(pickMoodBucket([])).toBe("day");
    expect(pickMoodBucket([{ date: "2026-05-01", score: 4 }])).toBe("day");
  });
});

// Berlin was the module's hard-coded calendar, so these expectations were
// always Berlin's. Naming it here keeps that visible now it is a parameter.
const BERLIN = "Europe/Berlin";

describe("aggregateMoodEntries()", () => {
  it("returns daily points unchanged for short windows", () => {
    const entries = [
      { date: "2026-05-01", score: 3 },
      { date: "2026-05-02", score: 4 },
      { date: "2026-05-03", score: 5 },
    ];
    const out = aggregateMoodEntries(entries, BERLIN);
    expect(out.bucket).toBe("day");
    expect(out.points).toHaveLength(3);
    expect(out.points.map((p) => p.score)).toEqual([3, 4, 5]);
  });

  it("aggregates to weekly mean for windows in the 91-730d range", () => {
    // 100-day span — pickBucket → "week".
    const entries = dayEntries("2026-01-01", 100, 4);
    const out = aggregateMoodEntries(entries, BERLIN);
    expect(out.bucket).toBe("week");
    // Constant input score = mean of every weekly bucket should be the
    // same constant (independent of partial-week edge effects).
    for (const point of out.points) {
      expect(point.score).toBeCloseTo(4, 2);
    }
    // 100 daily points become roughly 14-15 weekly buckets — at least
    // far fewer than the raw count.
    expect(out.points.length).toBeLessThan(entries.length / 5);
  });

  it("aggregates to monthly mean for windows > 730 days", () => {
    const entries = dayEntries("2024-01-01", 800, 5);
    const out = aggregateMoodEntries(entries, BERLIN);
    expect(out.bucket).toBe("month");
    // 800 days ≈ 27 months — well below the daily count.
    expect(out.points.length).toBeLessThan(50);
    expect(out.points.length).toBeGreaterThan(20);
    // Every monthly bucket should hold the constant score.
    for (const point of out.points) {
      expect(point.score).toBeCloseTo(5, 2);
    }
  });

  it("emits empty points array for empty input", () => {
    expect(aggregateMoodEntries([], BERLIN)).toEqual({
      bucket: "day",
      points: [],
    });
  });
});

// vi.mock hoists above test execution; share the long-series fixture
// via vi.hoisted so the mock factory can reach it without a TDZ.
// We build 30 entries spaced 5 days apart so the *visible* window
// (last 30 points = the default) spans ~150 days, comfortably past
// the 90-day threshold that flips the bucket from "day" to "week".
const { __longSeries } = vi.hoisted(() => {
  const out: Array<{ date: string; score: number }> = [];
  const start = new Date(Date.UTC(2025, 11, 1)); // 2025-12-01
  for (let i = 0; i < 30; i++) {
    const dt = new Date(start.getTime() + i * 5 * 86400000);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    out.push({ date: `${yy}-${mm}-${dd}`, score: 4 });
  }
  return { __longSeries: out };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { entries: __longSeries, summary: null },
    isLoading: false,
  }),
  useQueryClient: () => ({
    cancelQueries: () => Promise.resolve(),
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    invalidateQueries: () => Promise.resolve(),
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

describe("<MoodChart> bucket chip", () => {
  it("paints the weekly chip when the data spans > 90 days", async () => {
    // Defer the import so the vi.mock above takes effect.
    const { I18nProvider } = await import("@/lib/i18n/context");
    // The 7/30/90 tabs are calendar-day windows anchored on now
    // (v1.37.29), so only the All range can hold a span past 90 days —
    // which is the state the weekly chip exists for.
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <MoodChart windowOverride="allTime" />
      </I18nProvider>,
    );
    // The chip text comes from `charts.bucketWeekly` ("Weekly avg").
    expect(html).toContain("Weekly avg");
  });
});
