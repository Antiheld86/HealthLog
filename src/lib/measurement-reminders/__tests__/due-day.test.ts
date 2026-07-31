/**
 * The due line on a checkup is a CALENDAR-day statement. "Tomorrow" means the
 * next date on the wall calendar, not roughly twenty-four hours from now, and
 * every case below is one where those two answers differ.
 *
 * Each instant is built from local wall-clock components rather than a UTC
 * string, so the suite says the same thing whatever zone it runs in — the CI
 * box is on UTC and a laptop is not.
 */
import { describe, it, expect } from "vitest";

import { relativeDueKey } from "../due-day";

/** A local wall-clock instant, as the ISO string the API hands the client. */
function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

/** The same wall clock as the epoch millis a component reads off `Date.now()`. */
function localNow(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

// A July week, deliberately: no IANA zone shifts its clocks mid-July, so
// building 01:00 or 23:59 from local components can never land on a skipped or
// repeated hour. Fri 17th, Sat 18th, Sun 19th.
const FRIDAY = 17;
const SATURDAY = 18;
const SUNDAY = 19;

describe("relativeDueKey", () => {
  it("still reads 'today' in the evening for a checkup that was due this morning", () => {
    expect(
      relativeDueKey(
        localIso(2026, 7, FRIDAY, 9),
        localNow(2026, 7, FRIDAY, 20),
      ),
    ).toEqual({ key: "measurementReminders.nextDue.today", days: 0 });
  });

  it("holds 'today' from first thing to last thing, either side of the due hour", () => {
    // Both ends of the same date sit more than twelve hours from the due time,
    // which is where a rolling-hours delta tips into the neighbouring day: it
    // would call the 07:00 checkup overdue by bedtime, and the 21:00 one
    // tomorrow at breakfast.
    expect(
      relativeDueKey(
        localIso(2026, 7, FRIDAY, 7),
        localNow(2026, 7, FRIDAY, 22),
      ),
    ).toEqual({ key: "measurementReminders.nextDue.today", days: 0 });
    expect(
      relativeDueKey(
        localIso(2026, 7, FRIDAY, 21),
        localNow(2026, 7, FRIDAY, 6),
      ),
    ).toEqual({ key: "measurementReminders.nextDue.today", days: 0 });
  });

  it("calls a Sunday 01:00 checkup two days out when read late on Friday", () => {
    // Twenty-six hours apart, so a rolling-hours delta rounds to one day and
    // says "tomorrow". Two dates separate them on the calendar.
    expect(
      relativeDueKey(
        localIso(2026, 7, SUNDAY, 1),
        localNow(2026, 7, FRIDAY, 23),
      ),
    ).toEqual({ key: "measurementReminders.nextDue.inDays", days: 2 });
  });

  it("calls a Saturday 23:59 checkup tomorrow when read just after Friday midnight", () => {
    // Just under forty-eight hours apart, so a rolling-hours delta rounds to
    // two days. It is the very next date on the calendar.
    expect(
      relativeDueKey(
        localIso(2026, 7, SATURDAY, 23, 59),
        localNow(2026, 7, FRIDAY, 0, 1),
      ),
    ).toEqual({ key: "measurementReminders.nextDue.tomorrow", days: 1 });
  });

  it("counts a checkup from yesterday as one day overdue, however recent", () => {
    // Forty-five minutes in the past. It was still yesterday's checkup.
    expect(
      relativeDueKey(
        localIso(2026, 7, FRIDAY, 23, 30),
        localNow(2026, 7, SATURDAY, 0, 15),
      ),
    ).toEqual({ key: "measurementReminders.overdueByDays", days: 1 });
  });

  it("counts whole calendar days for a checkup further out", () => {
    expect(
      relativeDueKey(
        localIso(2026, 7, FRIDAY + 7, 6),
        localNow(2026, 7, FRIDAY, 22),
      ),
    ).toEqual({ key: "measurementReminders.nextDue.inDays", days: 7 });
  });

  it("says nothing is scheduled rather than crashing on a date it cannot read", () => {
    expect(relativeDueKey("not-a-date", localNow(2026, 7, FRIDAY, 12))).toEqual(
      { key: "measurementReminders.nextDue.none", days: 0 },
    );
  });

  it("says nothing is scheduled when there is no due date at all", () => {
    expect(relativeDueKey(null, localNow(2026, 7, FRIDAY, 12))).toEqual({
      key: "measurementReminders.nextDue.none",
      days: 0,
    });
  });
});
