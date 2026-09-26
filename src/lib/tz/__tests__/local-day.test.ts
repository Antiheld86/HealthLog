import { describe, expect, it } from "vitest";
import {
  getUserTodayBounds,
  localDayWindow,
  localHmAsUtc,
  startOfLocalDayInTz,
  startOfLocalDayKey,
} from "@/lib/tz/local-day";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { wallClockInTz, zonedWallClockToUtc } from "@/lib/tz/wall-clock";

const HOUR_MS = 60 * 60 * 1000;

describe("zonedWallClockToUtc", () => {
  it("resolves a wall clock in a positive-offset zone to the right UTC instant", () => {
    // 00:30 CEST (UTC+2) on 2026-05-11 → 22:30 UTC on 2026-05-10.
    const utc = zonedWallClockToUtc(
      { year: 2026, month: 5, day: 11, hour: 0, minute: 30 },
      "Europe/Berlin",
    );
    expect(utc.toISOString()).toBe("2026-05-10T22:30:00.000Z");
  });

  it("round-trips through wallClockInTz across the spring-forward boundary", () => {
    // 03:30 local on Berlin's spring-forward day (clocks jumped 02:00→03:00).
    const utc = zonedWallClockToUtc(
      { year: 2026, month: 3, day: 29, hour: 3, minute: 30 },
      "Europe/Berlin",
    );
    const parts = wallClockInTz(utc, "Europe/Berlin");
    expect(parts.hour).toBe(3);
    expect(parts.minute).toBe(30);
    expect(parts.day).toBe(29);
  });

  it("resolves a negative-offset zone", () => {
    // 00:30 NZST (UTC+12) on 2026-06-15 → 12:30 UTC on 2026-06-14.
    const utc = zonedWallClockToUtc(
      { year: 2026, month: 6, day: 15, hour: 0, minute: 30 },
      "Pacific/Auckland",
    );
    expect(utc.toISOString()).toBe("2026-06-14T12:30:00.000Z");
  });

  it("falls back to host-local when tz is undefined", () => {
    const utc = zonedWallClockToUtc(
      { year: 2026, month: 6, day: 15, hour: 14, minute: 30, second: 15 },
      undefined,
    );
    expect(utc.getTime()).toBe(new Date(2026, 5, 15, 14, 30, 15).getTime());
  });
});

describe("startOfLocalDayInTz", () => {
  it("anchors at the user's local midnight, not UTC midnight", () => {
    // 2026-06-15 22:00 UTC is already 2026-06-16 00:00 in Berlin (UTC+2),
    // so the local day floor must land on the Berlin 2026-06-16 midnight
    // instant (2026-06-15T22:00:00Z) — never 2026-06-16T00:00:00Z.
    const instant = new Date("2026-06-15T23:30:00.000Z");
    const floor = startOfLocalDayInTz(instant, "Europe/Berlin");
    const parts = wallClockInTz(floor, "Europe/Berlin");
    expect(parts.hour).toBe(0);
    expect(parts.minute).toBe(0);
    expect(parts.second).toBe(0);
    expect(floor.toISOString()).toBe("2026-06-15T22:00:00.000Z");
  });

  it("handles negative offsets (Pacific/Auckland) — late-local reading stays on its day", () => {
    // 2026-06-15 23:30 NZST (UTC+12) is 2026-06-15T11:30Z; the local day
    // floor is Auckland 2026-06-15 midnight = 2026-06-14T12:00:00Z.
    const instant = new Date("2026-06-15T11:30:00.000Z");
    const floor = startOfLocalDayInTz(instant, "Pacific/Auckland");
    const parts = wallClockInTz(floor, "Pacific/Auckland");
    expect(parts.hour).toBe(0);
    expect(parts.day).toBe(15);
  });

  it("is DST-safe across the spring-forward boundary", () => {
    // Europe/Berlin springs forward 2026-03-29 02:00→03:00.
    const instant = new Date("2026-03-29T10:00:00.000Z");
    const floor = startOfLocalDayInTz(instant, "Europe/Berlin");
    const parts = wallClockInTz(floor, "Europe/Berlin");
    expect(parts.hour).toBe(0);
    expect(parts.day).toBe(29);
  });

  it("falls back to host-local day when tz is undefined", () => {
    const instant = new Date(2026, 5, 15, 14, 30, 0);
    const floor = startOfLocalDayInTz(instant, undefined);
    expect(floor.getHours()).toBe(0);
    expect(floor.getDate()).toBe(15);
  });
});

describe("getUserTodayBounds — DST-safe local-day window", () => {
  it("spans a full 24h on an ordinary (non-transition) day", () => {
    const now = new Date("2026-06-15T14:30:00.000Z");
    const { start, end } = getUserTodayBounds(now, "Europe/Berlin");
    // Berlin is CEST (UTC+2) in June: local midnight = 2026-06-14T22:00Z.
    expect(start.toISOString()).toBe("2026-06-14T22:00:00.000Z");
    // Inclusive end is the last ms before the next local midnight.
    expect(end.getTime() - start.getTime()).toBe(24 * HOUR_MS - 1);
  });

  it("fall-back day is 25h and keeps a 23:30-local dose inside 'today'", () => {
    // Europe/Berlin falls back 2026-10-25 03:00→02:00 (a 25-hour local day).
    // A read taken at 23:30 local that evening.
    const now = zonedWallClockToUtc(
      { year: 2026, month: 10, day: 25, hour: 23, minute: 30 },
      "Europe/Berlin",
    );
    const { start, end } = getUserTodayBounds(now, "Europe/Berlin");

    // The window covers the real 25-hour local day, not a hardcoded 24h.
    expect(end.getTime() - start.getTime()).toBe(25 * HOUR_MS - 1);

    // The 23:30 dose — which the old 24h window dropped off the med cards —
    // now falls inside [start, end].
    const dose2330 = zonedWallClockToUtc(
      { year: 2026, month: 10, day: 25, hour: 23, minute: 30 },
      "Europe/Berlin",
    );
    expect(dose2330.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(dose2330.getTime()).toBeLessThanOrEqual(end.getTime());

    // Both bounds sit at local midnight of their respective calendar days.
    expect(wallClockInTz(start, "Europe/Berlin").hour).toBe(0);
    expect(wallClockInTz(start, "Europe/Berlin").day).toBe(25);
  });

  it("spring-forward day is 23h and does not bleed into tomorrow's 00:30 dose", () => {
    // Europe/Berlin springs forward 2026-03-29 02:00→03:00 (a 23-hour day).
    const now = zonedWallClockToUtc(
      { year: 2026, month: 3, day: 29, hour: 20, minute: 0 },
      "Europe/Berlin",
    );
    const { start, end } = getUserTodayBounds(now, "Europe/Berlin");

    // The window covers only the real 23-hour local day.
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR_MS - 1);

    // Tomorrow's 00:30 dose belongs to 2026-03-30, so it must fall OUTSIDE
    // today — the old fixed-24h window double-counted it as "today".
    const tomorrow0030 = zonedWallClockToUtc(
      { year: 2026, month: 3, day: 30, hour: 0, minute: 30 },
      "Europe/Berlin",
    );
    expect(tomorrow0030.getTime()).toBeGreaterThan(end.getTime());
  });

  it("is correct for a negative-offset zone (America/Los_Angeles)", () => {
    // 2026-06-15 20:00 PDT (UTC-7) → 2026-06-16T03:00Z. The local day is
    // still the 15th, so the window must anchor on LA's 2026-06-15 midnight.
    const now = new Date("2026-06-16T03:00:00.000Z");
    const { start, end } = getUserTodayBounds(now, "America/Los_Angeles");
    expect(start.toISOString()).toBe("2026-06-15T07:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(24 * HOUR_MS - 1);
    expect(wallClockInTz(start, "America/Los_Angeles").day).toBe(15);
  });
});

describe("localHmAsUtc — DST transition days", () => {
  const TZ = "Europe/Berlin";
  // Berlin 2026 transitions: spring forward Mar 29 (02:00 CET → 03:00 CEST),
  // autumn back Oct 25 (03:00 CEST → 02:00 CET).

  /** The wall clock an observer in `tz` reads at `instant`, as "HH:mm". */
  function localHm(instant: Date, tz: string): string {
    const p = wallClockInTz(instant, tz);
    return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  }

  it("resolves a 20:00 slot to 20:00 local from a PRE-transition reference (autumn back)", () => {
    // 02:30 CEST — before the 03:00 fall-back. The old implementation
    // sampled the +02:00 offset here and applied it to the 20:00 target,
    // which by then sits at +01:00, yielding 19:00 local.
    const ref = new Date("2026-10-25T00:30:00.000Z");
    const slot = localHmAsUtc(ref, TZ, 20, 0);
    expect(localHm(slot, TZ)).toBe("20:00");
    expect(slot.toISOString()).toBe("2026-10-25T19:00:00.000Z");
  });

  it("resolves a 20:00 slot to 20:00 local from a POST-transition reference (autumn back)", () => {
    const ref = new Date("2026-10-25T05:00:00.000Z"); // 06:00 CET
    const slot = localHmAsUtc(ref, TZ, 20, 0);
    expect(localHm(slot, TZ)).toBe("20:00");
    expect(slot.toISOString()).toBe("2026-10-25T19:00:00.000Z");
  });

  it("keys the SAME instant for one slot regardless of reference side (autumn back)", () => {
    // The dedupe contract: projector, reminder worker and intake write path
    // each pass their own reference instant for the same slot. They must
    // agree byte-for-byte or a duplicate pending row becomes reachable.
    const pre = new Date("2026-10-25T00:30:00.000Z");
    const mid = new Date("2026-10-25T01:30:00.000Z");
    const post = new Date("2026-10-25T05:00:00.000Z");
    const slots = [pre, mid, post].map((r) =>
      localHmAsUtc(r, TZ, 20, 0).getTime(),
    );
    expect(new Set(slots).size).toBe(1);
  });

  it("keys the SAME instant for one slot regardless of reference side (spring forward)", () => {
    const pre = new Date("2026-03-29T00:30:00.000Z"); // 01:30 CET
    const post = new Date("2026-03-29T09:00:00.000Z"); // 11:00 CEST
    expect(localHmAsUtc(pre, TZ, 20, 0).getTime()).toBe(
      localHmAsUtc(post, TZ, 20, 0).getTime(),
    );
    expect(localHm(localHmAsUtc(pre, TZ, 20, 0), TZ)).toBe("20:00");
  });

  it("agrees with startOfLocalDayInTz at 00:00 on BOTH transition days", () => {
    // By construction now — both route through the same two-pass converge.
    // They used to disagree by an hour here, which opened the one-shot
    // on-time band an hour into the previous local day.
    for (const iso of [
      "2026-03-29T00:30:00.000Z", // spring forward, pre
      "2026-03-29T09:00:00.000Z", // spring forward, post
      "2026-10-25T00:30:00.000Z", // autumn back, pre
      "2026-10-25T05:00:00.000Z", // autumn back, post
    ]) {
      const ref = new Date(iso);
      expect(localHmAsUtc(ref, TZ, 0, 0).getTime()).toBe(
        startOfLocalDayInTz(ref, TZ).getTime(),
      );
    }
  });

  it("resolves an early-morning slot on the spring-forward day", () => {
    // 01:30 local exists (CET, +01:00) on the spring-forward day; 03:30
    // exists (CEST, +02:00). Both must round-trip to their own wall clock.
    const ref = new Date("2026-03-29T12:00:00.000Z");
    expect(localHmAsUtc(ref, TZ, 1, 30).toISOString()).toBe(
      "2026-03-29T00:30:00.000Z",
    );
    expect(localHmAsUtc(ref, TZ, 3, 30).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("resolves slots in a southern-hemisphere zone whose transitions invert", () => {
    // Australia/Sydney falls back 2026-04-05 03:00 AEDT → 02:00 AEST.
    const sydney = "Australia/Sydney";
    const pre = new Date("2026-04-04T14:30:00.000Z"); // 01:30 AEDT (+11), Apr 5
    const post = new Date("2026-04-05T09:00:00.000Z"); // 19:00 AEST (+10), Apr 5
    const a = localHmAsUtc(pre, sydney, 20, 0);
    const b = localHmAsUtc(post, sydney, 20, 0);
    expect(a.getTime()).toBe(b.getTime());
    expect(localHm(a, sydney)).toBe("20:00");
  });
});

describe("startOfLocalDayKey / localDayWindow — every day of the year", () => {
  const ZONES = [
    "America/New_York",
    "America/Santiago",
    "America/Havana",
    "Pacific/Auckland",
    "Pacific/Tongatapu",
    "Australia/Sydney",
    "Europe/Berlin",
    "Asia/Kathmandu",
    "UTC",
  ];

  // The first instant of the day reads the day's key, and the millisecond
  // before it reads the previous key: it is exactly where the day begins.
  for (const tz of ZONES) {
    it(`starts each 2026 day at its first local instant in ${tz}`, () => {
      let key = "2026-01-01";
      for (let i = 0; i < 365; i++) {
        const { dayStart, dayEnd } = localDayWindow(key, tz);
        expect(userDayKey(dayStart, tz), `${tz} ${key}`).toBe(key);
        expect(
          userDayKey(new Date(dayStart.getTime() - 1), tz),
          `${tz} ${key}`,
        ).toBe(shiftDateKey(key, -1));
        const hours = (dayEnd.getTime() - dayStart.getTime()) / 3_600_000;
        expect(hours).toBeGreaterThanOrEqual(23);
        expect(hours).toBeLessThanOrEqual(25);
        expect(startOfLocalDayKey(key, tz).getTime()).toBe(dayStart.getTime());
        key = shiftDateKey(key, 1);
      }
    });
  }

  it.each([
    // Midnight is skipped: the day begins at 01:00 local.
    ["America/Santiago", "2026-09-06", "2026-09-06T04:00:00.000Z", 23],
    ["America/Havana", "2026-03-08", "2026-03-08T05:00:00.000Z", 23],
    // Far from UTC, the offset at UTC midnight is not the offset at local
    // midnight on a transition day.
    ["Pacific/Auckland", "2026-04-05", "2026-04-04T11:00:00.000Z", 25],
    ["Pacific/Auckland", "2026-09-27", "2026-09-26T12:00:00.000Z", 23],
    ["Australia/Sydney", "2026-04-05", "2026-04-04T13:00:00.000Z", 25],
    ["America/New_York", "2026-11-01", "2026-11-01T04:00:00.000Z", 25],
    ["Europe/Berlin", "2026-03-29", "2026-03-28T23:00:00.000Z", 23],
    ["Pacific/Tongatapu", "2026-07-01", "2026-06-30T11:00:00.000Z", 24],
  ])("%s %s starts at %s and lasts %i h", (tz, key, start, hours) => {
    const { dayStart, dayEnd } = localDayWindow(key, tz);
    expect(dayStart.toISOString()).toBe(start);
    expect((dayEnd.getTime() - dayStart.getTime()) / 3_600_000).toBe(hours);
    expect(
      startOfLocalDayInTz(new Date(dayStart.getTime() + 3_600_000), tz),
    ).toEqual(dayStart);
  });
});

describe("zonedWallClockToUtc — skipped wall clocks", () => {
  it("reads a skipped midnight as the moment the clocks jump", () => {
    expect(
      zonedWallClockToUtc(
        { year: 2026, month: 9, day: 6, hour: 0, minute: 0 },
        "America/Santiago",
      ).toISOString(),
    ).toBe("2026-09-06T04:00:00.000Z");
  });

  it("reads 02:30 on the Berlin spring-forward day as 03:30 summer time", () => {
    expect(
      zonedWallClockToUtc(
        { year: 2026, month: 3, day: 29, hour: 2, minute: 30 },
        "Europe/Berlin",
      ).toISOString(),
    ).toBe("2026-03-29T01:30:00.000Z");
  });

  it("agrees with the day start at 00:00 where midnight is skipped", () => {
    const ref = new Date("2026-09-06T15:00:00.000Z");
    expect(localHmAsUtc(ref, "America/Santiago", 0, 0)).toEqual(
      startOfLocalDayInTz(ref, "America/Santiago"),
    );
  });
});
