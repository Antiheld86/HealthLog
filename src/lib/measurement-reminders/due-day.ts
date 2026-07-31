/**
 * The one place a Vorsorge reminder's next-due instant becomes the words a
 * person reads: "heute" / "morgen" / "in N Tagen" / "überfällig seit N Tagen".
 *
 * It used to live inside the two surfaces that render it — the `/checkups`
 * page and the dashboard summary card — as two hand-copied bodies. The page
 * copy was fixed to compare CALENDAR days; the dashboard copy was not, and
 * kept differencing raw instants. So the same reminder read "morgen" on one
 * screen and "in 2 Tagen" on the other, and a reminder due this morning
 * dropped out of "heute" over the course of the afternoon. One body here, both
 * surfaces importing it, and the two cannot disagree again.
 *
 * Sits beside `scheduling.ts` (which computes the server-authoritative
 * `nextDueAt`) because this is the read side of the same value. Nothing in
 * this file touches the database or the network, so a client component can
 * import it directly.
 */
import { DEFAULT_TIMEZONE, isValidTimezone } from "@/lib/tz/format";
import { startOfLocalDayInTz } from "@/lib/tz/local-day";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fully-qualified i18n key plus the day count it interpolates. */
export interface RelativeDue {
  key: string;
  days: number;
}

/**
 * v1.32.36 — returns a FULLY-QUALIFIED i18n key, not a bare tail. A call site
 * that interpolates the tail onto the namespace root anchors the
 * reverse-coverage guard at that bare namespace, which marks every key under
 * it reachable and turns the guard into a no-op for the whole namespace. The
 * guard now refuses that shape outright, so the key is built whole here.
 *
 * `timeZone` is required on purpose. It used to be implicit — the day floor
 * silently took the DEVICE clock while the date printed next to it took the
 * profile clock, so on a laptop set to another zone the card could print a
 * date and a phrase that contradicted each other. Naming the zone is how a
 * caller says which of those two clocks it means, and there is no default
 * because the missing answer was the whole bug: a silent caller got something
 * plausible-looking rather than an error. Pass what the neighbouring date
 * label renders in — `useDisplayTimezone()` on the client.
 */
export function relativeDueKey(
  nextDueAt: string | null,
  now: number,
  timeZone: string,
): RelativeDue {
  if (!nextDueAt) return { key: "measurementReminders.nextDue.none", days: 0 };
  const due = new Date(nextDueAt);
  if (Number.isNaN(due.getTime()))
    return { key: "measurementReminders.nextDue.none", days: 0 };
  // Resolve exactly as `relativeCalendarDate` and `fmt.date` do (issue #490):
  // a usable zone stands, anything else lands on Berlin. Note where it does
  // NOT land — the device. Falling back to the host clock is what let the two
  // halves of this card drift apart, and a zone the profile mirror could not
  // make sense of has to end up wherever the printed date ends up.
  const zone = isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  // v1.18.9 (recon) — compare CALENDAR-day deltas in the user's zone, not a
  // rolling-24h delta. A reminder due at 09:00 viewed the same evening at
  // 20:00 must still read "heute", and one whose due calendar-day is before
  // today must read "überfällig" — a raw `(due - now) / DAY_MS` round would
  // mis-bucket both. Floor each instant to its local day start first.
  const dueDay = startOfLocalDayInTz(due, zone).getTime();
  const nowDay = startOfLocalDayInTz(new Date(now), zone).getTime();
  const deltaDays = Math.round((dueDay - nowDay) / DAY_MS);
  if (deltaDays < 0)
    return {
      key: "measurementReminders.overdueByDays",
      days: Math.abs(deltaDays),
    };
  if (deltaDays === 0)
    return { key: "measurementReminders.nextDue.today", days: 0 };
  if (deltaDays === 1)
    return { key: "measurementReminders.nextDue.tomorrow", days: 1 };
  return { key: "measurementReminders.nextDue.inDays", days: deltaDays };
}
