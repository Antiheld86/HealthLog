import { describe, expect, it } from "vitest";

import { computeStreak } from "../streak";
import { userDayKey } from "@/lib/tz/format";

const ZONES = [
  "America/New_York",
  "America/Santiago",
  "Pacific/Auckland",
  "Pacific/Tongatapu",
  "Europe/Berlin",
  "UTC",
];

/** The last `n` local days ending with today's key in `tz`. */
function lastDays(now: Date, tz: string, n: number, skipToday = false) {
  const keys = new Set<string>();
  const today = userDayKey(now, tz);
  const [y, m, d] = today.split("-").map(Number);
  for (let i = skipToday ? 1 : 0; i < n + (skipToday ? 1 : 0); i++) {
    keys.add(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  }
  return keys;
}

describe("computeStreak", () => {
  // Evening in New York is already the next UTC day, and the early hours in
  // Auckland or Tonga are still the previous UTC day: both ends of the walk.
  const INSTANTS = [
    "2026-03-08T01:30:00.000Z",
    "2026-03-08T23:30:00.000Z",
    "2026-04-05T13:00:00.000Z",
    "2026-09-06T03:30:00.000Z",
    "2026-10-25T00:30:00.000Z",
    "2026-11-01T06:00:00.000Z",
  ];

  for (const tz of ZONES) {
    for (const iso of INSTANTS) {
      const now = new Date(iso);
      it(`counts three logged days ending today in ${tz} at ${iso}`, () => {
        const streak = computeStreak(lastDays(now, tz, 3), tz, now);
        expect(streak.currentDays).toBe(3);
        expect(streak.longest).toBe(3);
      });
      it(`counts from yesterday when today is not logged yet in ${tz} at ${iso}`, () => {
        const streak = computeStreak(lastDays(now, tz, 4, true), tz, now);
        expect(streak.currentDays).toBe(4);
      });
    }
  }

  it("breaks the current streak on a gap", () => {
    const now = new Date("2026-06-10T20:00:00.000Z");
    const tz = "America/New_York";
    const streak = computeStreak(
      new Set([
        "2026-06-10",
        "2026-06-09",
        "2026-06-07",
        "2026-06-06",
        "2026-06-05",
      ]),
      tz,
      now,
    );
    expect(streak.currentDays).toBe(2);
    expect(streak.longest).toBe(3);
  });

  it("returns zeros for no activity", () => {
    expect(computeStreak(new Set(), "UTC")).toEqual({
      currentDays: 0,
      longest: 0,
    });
  });
});
