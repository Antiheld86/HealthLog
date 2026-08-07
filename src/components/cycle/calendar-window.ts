/**
 * The date range the /cycle page reads, and what a month outside it needs.
 *
 * The page reads one anchored window — ninety days back, half a year forward —
 * and that window drives the ring, the forecast panel and the temperature
 * chart, all of which are about today. The month grid is not: it navigates
 * freely, and a month the anchored read does not cover came back with no days
 * at all. The cells still rendered (they come from the month, not the read) and
 * still opened the log sheet, and the write behind it still landed — the period
 * route is built for back-dating and re-anchors the neighbouring cycles for it.
 * What did not happen is anything visible. Save an April flow in August and the
 * sheet closes onto a month the read never carried, so the entry appears not to
 * have been made, and entering it again does not help.
 *
 * So the month grid gets its own read when it steps outside the anchor. A month
 * is a bounded thing to fetch, the anchored window stays exactly as it was for
 * every surface that means "today", and the two grids merge by date.
 *
 * Pure and dateless — the caller supplies both the month and the window.
 */

/** An inclusive `YYYY-MM-DD` range, the shape the calendar read takes. */
export interface CalendarWindow {
  from: string;
  to: string;
}

/** Zero-padded `YYYY-MM-DD`. */
function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** First and last day of a `YYYY-MM` month. */
export function monthBounds(month: string): CalendarWindow {
  const [year, monthIndex] = month.split("-").map(Number);
  // Day 0 of the following month is the last day of this one, leap years and all.
  const lastDay = new Date(year, monthIndex, 0).getDate();
  return { from: ymd(year, monthIndex, 1), to: ymd(year, monthIndex, lastDay) };
}

/**
 * The extra window a visible month needs, or null when `anchor` already covers
 * it and the page should read nothing more. Day keys are zero-padded, so a
 * plain string compare is a date compare.
 */
export function monthWindowOutside(
  month: string,
  anchor: CalendarWindow,
): CalendarWindow | null {
  const bounds = monthBounds(month);
  if (bounds.from >= anchor.from && bounds.to <= anchor.to) return null;
  return bounds;
}

/** The `YYYY-MM` a `YYYY-MM-DD` day key belongs to. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}
