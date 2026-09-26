/**
 * A reminder's `anchorDate` / `endsOn` are instants (the form sends local
 * midnight), while the recurrence engine takes calendar dates. The adapter
 * must hand over the day the instant falls on in the user's zone: east of
 * UTC local midnight is still the previous UTC day, and a weekly plan
 * anchored there must not start a day early.
 */
import { describe, expect, it } from "vitest";

import { wallClockInTz, zonedWallClockToUtc } from "@/lib/tz/wall-clock";

import { computeReminderNextDueAt } from "../scheduling";

const ZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Santiago",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Pacific/Auckland",
  "Pacific/Tongatapu",
] as const;

function localMidnight(tz: string, y: number, m: number, d: number): Date {
  return zonedWallClockToUtc(
    { year: y, month: m, day: d, hour: 0, minute: 0 },
    tz,
  );
}

function localLabel(at: Date | null, tz: string): string | null {
  if (!at) return null;
  const p = wallClockInTz(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} w${p.weekday}`;
}

describe.each(ZONES)("reminder anchors in %s", (tz) => {
  it("a daily RRULE starts on the local anchor day", () => {
    const anchor = localMidnight(tz, 2026, 9, 14);
    const next = computeReminderNextDueAt(
      {
        intervalDays: null,
        rrule: "FREQ=DAILY",
        anchorDate: anchor,
        notifyHour: 8,
        lastSatisfiedAt: null,
        createdAt: new Date("2026-09-01T12:00:00Z"),
      },
      tz,
      new Date("2026-09-10T12:00:00Z"),
    );
    expect(localLabel(next, tz)).toBe("2026-09-14 08:00 w1");
  });

  it("a course that ends on a local day keeps that day's evening slot", () => {
    const next = computeReminderNextDueAt(
      {
        intervalDays: null,
        rrule: "FREQ=DAILY;BYHOUR=7,19",
        anchorDate: localMidnight(tz, 2026, 9, 14),
        endsOn: zonedWallClockToUtc(
          { year: 2026, month: 9, day: 20, hour: 10, minute: 0 },
          tz,
        ),
        notifyHour: 7,
        lastSatisfiedAt: null,
        createdAt: new Date("2026-09-01T12:00:00Z"),
      },
      tz,
      zonedWallClockToUtc(
        { year: 2026, month: 9, day: 20, hour: 8, minute: 0 },
        tz,
      ),
    );
    expect(localLabel(next, tz)).toBe("2026-09-20 19:00 w0");
  });
});
