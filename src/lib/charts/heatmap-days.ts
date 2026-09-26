import { shiftDateKey, userDayKey } from "@/lib/tz/format";

/** One calendar-heatmap column entry: a local day and where it sits. */
export interface HeatmapDay {
  /** `YYYY-MM-DD` in the user's zone. */
  dateKey: string;
  /** Weekday with Monday = 0 … Sunday = 6. */
  dow: number;
  /** Month index 0–11. */
  month: number;
}

/**
 * The last `days` local days in `timeZone`, oldest first, ending with today.
 *
 * Built from today's key in the user's zone and stepped on keys. The heatmaps
 * used to take `now − n·24 h` and cut the key in UTC, so in the evening west
 * of UTC (or the morning east of it) "today" was a different day from the one
 * the server had keyed the user's readings on, and the newest cell showed the
 * wrong day. Weekday and month come from the key itself.
 */
export function heatmapDays(
  now: Date,
  timeZone: string,
  days: number,
): HeatmapDay[] {
  const today = userDayKey(now, timeZone);
  const out: HeatmapDay[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const dateKey = shiftDateKey(today, -back);
    const [y, m, d] = dateKey.split("-").map(Number);
    const utc = new Date(Date.UTC(y, m - 1, d));
    out.push({ dateKey, dow: (utc.getUTCDay() + 6) % 7, month: m - 1 });
  }
  return out;
}
