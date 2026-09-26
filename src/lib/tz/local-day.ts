/**
 * Local-calendar-day helpers built on `wallClockInTz`.
 *
 * Merged in from the former `src/lib/timezone.ts` so every
 * Intl-backed timezone primitive lives under `src/lib/tz/`. The
 * wall-clock decomposition itself is `wallClockInTz` (see
 * `./wall-clock`); the helpers here derive UTC instants from the
 * user's local calendar day — today's bounds for database queries,
 * the local weekday, and the UTC instant of a local `hh:mm`.
 */
import { shiftDateKey } from "./format";
import { wallClockInTz, zonedWallClockToUtc } from "./wall-clock";

/**
 * Get the start (midnight) and end (23:59:59.999) of "today" in the user's
 * timezone, returned as UTC Date objects suitable for database queries.
 *
 * DST-safe. Both bounds route through {@link startOfLocalDayInTz}, whose
 * two-pass solver settles the zone offset AT the target local midnight —
 * not at `now`. The window therefore spans the user's real local day even
 * when it is 23 h (spring-forward) or 25 h (fall-back): the previous
 * implementation sampled the offset at `now` and hardcoded a 24 h length,
 * so on a fall-back day the last local hour (e.g. a 23:30 dose) fell
 * OUTSIDE `[midnight, midnight+24h)` and on a spring-forward day the window
 * bled one hour into the next local day.
 */
export function getUserTodayBounds(
  now: Date,
  tz: string,
): { start: Date; end: Date } {
  const start = startOfLocalDayInTz(now, tz);
  // Start of the NEXT local day. Advancing 25 h always crosses into the next
  // calendar day (a real day is 23–25 h, never ≤ 12.5 h, so 25 h can neither
  // fall short of the next day nor skip past it), then floor back to that
  // day's local midnight. `end` is the inclusive last millisecond of today.
  const nextDayStart = startOfLocalDayInTz(
    new Date(start.getTime() + 25 * 60 * 60 * 1000),
    tz,
  );
  const end = new Date(nextDayStart.getTime() - 1);

  return { start, end };
}

/**
 * The first instant of the local calendar day `year-month-day` in `tz`.
 *
 * Usually local 00:00. Where midnight itself is skipped by a DST change
 * (America/Santiago, America/Havana, Asia/Beirut move their clocks at
 * 00:00), the day starts at the transition instant, 01:00 local. Where
 * midnight repeats (a change at 01:00 back to 00:00), it is the first of the
 * two midnights.
 *
 * Candidates are local midnight under every offset the zone observes within
 * 14 hours of that date's UTC midnight (any offset in use lies within
 * ±14 h); the earliest candidate that already reads the target date is the
 * day's start. Reading one offset at UTC midnight instead picked the wrong
 * one on transition days in zones far from UTC (Pacific/Auckland) and landed
 * a day early where midnight is skipped.
 */
function firstInstantOfLocalDay(
  year: number,
  month: number,
  day: number,
  tz: string,
): Date {
  const utcMidnight = Date.UTC(year, month - 1, day);
  const offsets = new Set<number>();
  for (const delta of [-14, 0, 14]) {
    offsets.add(offsetMinutesAt(new Date(utcMidnight + delta * 3_600_000), tz));
  }
  let best: number | null = null;
  for (const offset of offsets) {
    const candidate = utcMidnight - offset * 60_000;
    const at = wallClockInTz(new Date(candidate), tz);
    if (at.year !== year || at.month !== month || at.day !== day) continue;
    if (best === null || candidate < best) best = candidate;
  }
  if (best !== null) return new Date(best);
  // No sampled offset lands on the date (a zone that skipped the whole day,
  // such as Pacific/Apia on 2011-12-30): fall back to the converged local
  // 00:00, which is the next instant that exists.
  return zonedWallClockToUtc({ year, month, day, hour: 0, minute: 0 }, tz);
}

/** UTC offset of `tz` at `instant`, in minutes east of UTC. */
function offsetMinutesAt(instant: Date, tz: string): number {
  const at = wallClockInTz(instant, tz);
  const asIfUtc = Date.UTC(
    at.year,
    at.month - 1,
    at.day,
    at.hour,
    at.minute,
    at.second,
  );
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

/**
 * The first instant of the local calendar day `dateKey` (`YYYY-MM-DD`) in
 * `tz`. The one start-of-day primitive for day keys; see
 * {@link firstInstantOfLocalDay} for the DST cases.
 */
export function startOfLocalDayKey(dateKey: string, tz: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return firstInstantOfLocalDay(year, month, day, tz);
}

/**
 * The `[dayStart, dayEnd)` UTC window of the local calendar day `dateKey`
 * in `tz`: 23, 24 or 25 hours long, whatever the day actually lasts. `dayEnd`
 * is the first instant of the following local day, so `measuredAt >=
 * dayStart AND measuredAt < dayEnd` selects exactly that day.
 */
export function localDayWindow(
  dateKey: string,
  tz: string,
): { dayStart: Date; dayEnd: Date } {
  return {
    dayStart: startOfLocalDayKey(dateKey, tz),
    dayEnd: startOfLocalDayKey(shiftDateKey(dateKey, 1), tz),
  };
}

/**
 * The first instant of the local calendar day `instant` falls on in `tz`
 * (usually local midnight; see {@link firstInstantOfLocalDay}).
 *
 * Canonical start-of-local-day primitive for instants. The
 * medication-scheduling `startOfLocalDay` (cadence) and `startOfDayInTz`
 * (recurrence) route through this so the day-floor never drifts between
 * surfaces. When `tz` is omitted the host's system-local day is used.
 */
export function startOfLocalDayInTz(
  instant: Date,
  tz: string | undefined,
): Date {
  if (!tz) {
    return new Date(
      instant.getFullYear(),
      instant.getMonth(),
      instant.getDate(),
      0,
      0,
      0,
      0,
    );
  }
  const parts = wallClockInTz(instant, tz);
  return firstInstantOfLocalDay(parts.year, parts.month, parts.day, tz);
}

/**
 * Get the day of the week (0=Sun..6=Sat) for a given instant in a specific
 * timezone.
 */
export function getDayOfWeekInTz(now: Date, tz: string): number {
  return wallClockInTz(now, tz).weekday;
}

/**
 * Compute the UTC instant of local `hh:mm` on the local calendar day
 * implied by `now` in `tz`.
 *
 * Two steps, both zone-aware: resolve which local calendar day `now`
 * falls on via {@link wallClockInTz}, then convert that day's `hh:mm`
 * wall clock to its UTC instant via `zonedWallClockToUtc`.
 *
 * The offset is therefore settled AT THE TARGET local time, not at the
 * reference instant. The previous implementation sampled the offset at
 * `now` and applied it to the target, so on a DST-transition day the
 * answer depended on which side of the transition the reference sat:
 * a 20:00 slot resolved to 19:00 local when the caller ticked before the
 * Berlin autumn change and correctly when it ticked after. That broke
 * two contracts at once — the projector, the reminder worker and the
 * intake write path key on the byte-identical slot instant, and they
 * pass different reference instants for the same slot, so a duplicate
 * pending row became reachable on that day.
 *
 * `zonedWallClockToUtc` runs the same two-pass converge as
 * {@link startOfLocalDayInTz}, so `localHmAsUtc(x, tz, 0, 0)` now equals
 * `startOfLocalDayInTz(x, tz)` BY CONSTRUCTION rather than by
 * coincidence — the two used to disagree by an hour on transition days,
 * which opened the one-shot on-time band an hour into the previous
 * local day.
 */
export function localHmAsUtc(
  now: Date,
  tz: string,
  hour: number,
  minute: number,
): Date {
  const parts = wallClockInTz(now, tz);
  return zonedWallClockToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour,
      minute,
      second: 0,
    },
    tz,
  );
}
