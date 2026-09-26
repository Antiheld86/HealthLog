/**
 * Calendar-day correctness of the recurrence engine across time zones.
 *
 * `Medication.startsOn` / `endsOn` are `@db.Date` columns: a calendar date
 * carried as UTC midnight. The engine used to read that midnight in the
 * user's zone, which west of UTC is the previous evening, so every
 * calendar-anchored cadence landed one day early there: a Monday plan fired
 * on Sundays in New York, a course starting on the 14th produced a dose on
 * the 13th, and a dose on the last course day in the evening vanished.
 *
 * Every assertion here is read back on the user's wall clock, and the whole
 * matrix runs under several HOST zones as well (the engine must not depend
 * on the machine it runs on). The host zone is switched through
 * `process.env.TZ` inside the test, because a `TZ=` prefix on the command
 * line is overridden by the vitest config.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { wallClockInTz } from "@/lib/tz/wall-clock";

import {
  advanceRollingOccurrence,
  expandRollingRetrospective,
  nextOccurrenceAfter,
  occurrencesBetween,
  type CanonicalSchedule,
  type RecurrenceContext,
} from "../recurrence";

const USER_ZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Santiago",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Pacific/Auckland",
  "Pacific/Tongatapu",
  "UTC",
] as const;

const HOST_ZONES = ["UTC", "America/Los_Angeles", "Pacific/Auckland"] as const;

function makeSchedule(
  overrides: Partial<CanonicalSchedule> = {},
): CanonicalSchedule {
  return {
    id: "sched-tz",
    rrule: null,
    rollingIntervalDays: null,
    timesOfDay: ["09:00"],
    daysOfWeek: null,
    windowStart: "09:00",
    windowEnd: "10:00",
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    ...overrides,
  };
}

function makeCtx(
  timeZone: string,
  medication: Partial<RecurrenceContext["medication"]> = {},
  lastIntakeAt: Date | null = null,
): RecurrenceContext {
  return {
    timeZone,
    lastIntakeAt,
    medication: {
      id: "med-tz",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: new Date("2026-01-01T12:00:00Z"),
      ...medication,
    },
  };
}

/** A calendar date the way Prisma hands back a `@db.Date` column. */
function date(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

function localYmd(at: Date, tz: string): string {
  const p = wallClockInTz(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function localHm(at: Date, tz: string): string {
  const p = wallClockInTz(at, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

const WIDE_FROM = new Date("2026-07-25T00:00:00Z");
const WIDE_TO = new Date("2026-12-31T00:00:00Z");

describe.each(HOST_ZONES)("recurrence engine on a %s host", (hostZone) => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = hostZone;
  });
  afterAll(() => {
    process.env.TZ = originalTz;
  });

  describe.each(USER_ZONES)("user in %s", (tz) => {
    it("FREQ=WEEKLY;BYDAY=MO fires on local Mondays at the local time", () => {
      const slots = occurrencesBetween(
        makeSchedule({ rrule: "FREQ=WEEKLY;BYDAY=MO" }),
        WIDE_FROM,
        WIDE_TO,
        makeCtx(tz, { startsOn: date("2026-09-01") }),
      );
      expect(slots.length).toBeGreaterThan(10);
      for (const s of slots) {
        expect(wallClockInTz(s.at, tz).weekday).toBe(1);
        expect(localHm(s.at, tz)).toBe("09:00");
      }
      expect(localYmd(slots[0].at, tz)).toBe("2026-09-07");
    });

    it("FREQ=DAILY starts on startsOn, never the day before", () => {
      const slots = occurrencesBetween(
        makeSchedule({ rrule: "FREQ=DAILY", timesOfDay: ["00:30", "23:30"] }),
        WIDE_FROM,
        new Date("2026-09-20T00:00:00Z"),
        makeCtx(tz, { startsOn: date("2026-09-14") }),
      );
      expect(localYmd(slots[0].at, tz)).toBe("2026-09-14");
      expect(localHm(slots[0].at, tz)).toBe("00:30");
      // One slot per time per day: no duplicate, no missing day.
      const days = slots.map((s) => localYmd(s.at, tz));
      for (const day of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
        expect(days.filter((d) => d === day)).toHaveLength(2);
      }
      expect(days.every((d) => d >= "2026-09-14")).toBe(true);
    });

    it("FREQ=DAILY keeps the evening dose of the last course day", () => {
      const ctx = makeCtx(tz, {
        startsOn: date("2026-09-14"),
        endsOn: date("2026-09-16"),
      });
      const schedule = makeSchedule({
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00", "23:00"],
      });
      const slots = occurrencesBetween(schedule, WIDE_FROM, WIDE_TO, ctx);
      expect(
        slots.map((s) => `${localYmd(s.at, tz)} ${localHm(s.at, tz)}`),
      ).toEqual([
        "2026-09-14 08:00",
        "2026-09-14 23:00",
        "2026-09-15 08:00",
        "2026-09-15 23:00",
        "2026-09-16 08:00",
        "2026-09-16 23:00",
      ]);
      // The next-due walk must reach the same last dose.
      const lastMorning = slots[4].at;
      const next = nextOccurrenceAfter(schedule, lastMorning, ctx);
      expect(next?.at.toISOString()).toBe(slots[5].at.toISOString());
      expect(nextOccurrenceAfter(schedule, slots[5].at, ctx)).toBeNull();
    });

    it("FREQ=MONTHLY;BYMONTHDAY=1 lands on the first of the local month", () => {
      const slots = occurrencesBetween(
        makeSchedule({ rrule: "FREQ=MONTHLY;BYMONTHDAY=1" }),
        WIDE_FROM,
        WIDE_TO,
        makeCtx(tz, { startsOn: date("2026-08-01") }),
      );
      expect(slots.map((s) => localYmd(s.at, tz))).toEqual([
        "2026-08-01",
        "2026-09-01",
        "2026-10-01",
        "2026-11-01",
        "2026-12-01",
      ]);
    });

    it("legacy every-other-Monday honours startsOn and the week phase", () => {
      const slots = occurrencesBetween(
        makeSchedule({ daysOfWeek: "i2;1" }),
        WIDE_FROM,
        new Date("2026-10-31T00:00:00Z"),
        makeCtx(tz, { startsOn: date("2026-09-14") }),
      );
      expect(slots.map((s) => localYmd(s.at, tz))).toEqual([
        "2026-09-14",
        "2026-09-28",
        "2026-10-12",
        "2026-10-26",
      ]);
    });

    it("legacy daily walk stops after the evening dose of endsOn", () => {
      const slots = occurrencesBetween(
        makeSchedule({ timesOfDay: ["21:00"] }),
        WIDE_FROM,
        WIDE_TO,
        makeCtx(tz, {
          startsOn: date("2026-09-14"),
          endsOn: date("2026-09-15"),
        }),
      );
      expect(slots.map((s) => localYmd(s.at, tz))).toEqual([
        "2026-09-14",
        "2026-09-15",
      ]);
    });

    it("a one-shot dose lands on its own date", () => {
      const slots = occurrencesBetween(
        makeSchedule({ timesOfDay: ["08:00"] }),
        WIDE_FROM,
        WIDE_TO,
        makeCtx(tz, {
          startsOn: date("2026-09-14"),
          endsOn: date("2026-09-14"),
          oneShot: true,
        }),
      );
      expect(
        slots.map((s) => `${localYmd(s.at, tz)} ${localHm(s.at, tz)}`),
      ).toEqual(["2026-09-14 08:00"]);
    });

    it("a rolling first dose is due on startsOn", () => {
      const schedule = makeSchedule({ rollingIntervalDays: 7 });
      const ctx = makeCtx(tz, { startsOn: date("2026-09-14") });
      const next = nextOccurrenceAfter(
        schedule,
        new Date("2026-09-01T12:00:00Z"),
        ctx,
      );
      expect(next && localYmd(next.at, tz)).toBe("2026-09-14");
      expect(next && localHm(next.at, tz)).toBe("09:00");
    });

    it("a rolling cadence counts calendar days from a late-evening intake", () => {
      // 23:30 local on 2026-10-30; +7 calendar days crosses the northern
      // fall-back weekend and the southern spring-forward season.
      const intake = zoned(tz, 2026, 10, 30, 23, 30);
      const schedule = makeSchedule({ rollingIntervalDays: 7 });
      const ctx = makeCtx(tz, { startsOn: date("2026-09-14") }, intake);
      const next = nextOccurrenceAfter(schedule, intake, ctx);
      expect(next && localYmd(next.at, tz)).toBe("2026-11-06");
      const after = next && advanceRollingOccurrence(schedule, next, ctx);
      expect(after && localYmd(after.at, tz)).toBe("2026-11-13");
    });

    it("a rolling retrospective back-fill keeps calendar days", () => {
      const first = zoned(tz, 2026, 9, 1, 23, 30);
      const last = zoned(tz, 2026, 9, 22, 23, 30);
      const slots = expandRollingRetrospective(
        makeSchedule({ rollingIntervalDays: 7 }),
        makeCtx(tz, { startsOn: date("2026-09-01") }),
        WIDE_FROM,
        new Date("2026-09-25T00:00:00Z"),
        [first, last],
        new Date("2026-09-24T12:00:00Z"),
      );
      expect(slots.map((s) => localYmd(s.at, tz))).toEqual([
        "2026-09-01",
        "2026-09-08",
        "2026-09-15",
        "2026-09-22",
      ]);
    });

    it("CYCLIC 3 on / 1 off counts whole weeks from startsOn in the local calendar", () => {
      // Starts on a Wednesday; the three "on" weeks are 21 consecutive days.
      const slots = occurrencesBetween(
        makeSchedule({
          rrule: "FREQ=DAILY",
          scheduleType: "CYCLIC",
          cyclicOnWeeks: 3,
          cyclicOffWeeks: 1,
          timesOfDay: ["23:30"],
        }),
        WIDE_FROM,
        new Date("2026-11-10T00:00:00Z"),
        makeCtx(tz, { startsOn: date("2026-09-16") }),
      );
      const days = slots.map((s) => localYmd(s.at, tz));
      expect(days[0]).toBe("2026-09-16");
      expect(days).toContain("2026-10-06");
      expect(days).not.toContain("2026-10-07");
      expect(days).not.toContain("2026-10-13");
      expect(days).toContain("2026-10-14");
      expect(days.filter((d) => d < "2026-10-14")).toHaveLength(21);
    });
  });

  describe("DST transition days", () => {
    const cases: Array<[string, string, string]> = [
      ["America/New_York", "2026-03-08", "2026-11-01"],
      ["America/Los_Angeles", "2026-03-08", "2026-11-01"],
      ["Europe/Berlin", "2026-03-29", "2026-10-25"],
      ["America/Santiago", "2026-09-06", "2026-04-05"],
      ["Pacific/Auckland", "2026-09-27", "2026-04-05"],
    ];
    it.each(cases)(
      "%s keeps one dose per local day across %s and %s",
      (tz, springDay, fallDay) => {
        for (const day of [springDay, fallDay]) {
          const start = date(day);
          const slots = occurrencesBetween(
            makeSchedule({
              rrule: "FREQ=DAILY",
              timesOfDay: ["00:30", "08:00", "23:30"],
            }),
            new Date(start.getTime() - 3 * 86_400_000),
            new Date(start.getTime() + 3 * 86_400_000),
            makeCtx(tz, { startsOn: date("2026-01-01") }),
          );
          const onDay = slots.filter((s) => localYmd(s.at, tz) === day);
          expect(onDay).toHaveLength(3);
          expect(localHm(onDay[1].at, tz)).toBe("08:00");
          expect(localHm(onDay[2].at, tz)).toBe("23:30");
        }
      },
    );

    it.each(cases)(
      "%s: a rolling cadence across the spring-forward day %s keeps calendar days",
      (tz, springDay) => {
        const [y, m, d] = springDay.split("-").map(Number);
        // 23:30 local three days before the clocks go forward; seven times
        // 24 h later is 00:30 on the day after the due day.
        const intake = zoned(tz, y, m, d - 3, 23, 30);
        const schedule = makeSchedule({ rollingIntervalDays: 7 });
        const ctx = makeCtx(tz, { startsOn: date("2026-01-01") }, intake);
        const next = nextOccurrenceAfter(schedule, intake, ctx);
        const due = new Date(Date.UTC(y, m - 1, d - 3 + 7));
        expect(next && localYmd(next.at, tz)).toBe(
          due.toISOString().slice(0, 10),
        );
      },
    );
  });
});

function zoned(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  // Solve the local wall clock to an instant without the engine under test.
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = wallClockInTz(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += Date.UTC(year, month - 1, day, hour, minute) - asUtc;
  }
  return new Date(guess);
}
