import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
/**
 * v1.12.3 — resolve the canonical slot instant of the dose a medication
 * card is currently surfacing, so the card's "Genommen" / "Skip" buttons
 * record THAT dose rather than letting the server snap "now" to the
 * nearest slot.
 *
 * Background: the medication cards show a single actionable dose — either
 * the current/overdue window (when `currentWindowStatus` resolves to
 * in_window / late / very_late) or the next-due dose (`nextDueAt`). The
 * intake POST historically carried `{ skipped }` only, so the server
 * defaulted `scheduledFor` to `now()` and snapped to whichever slot was
 * nearest. For a twice-daily 07:00 / 19:00 medication a morning tap (before
 * the 13:00 midpoint) therefore marked the 07:00 dose even when the user
 * meant a different slot, and a non-deliberate morning tap mis-recorded the
 * morning dose. Threading the displayed dose's slot instant onto the POST
 * lets the server resolve the exact dose the user is looking at,
 * deterministically and independently of the wall-clock.
 *
 * The returned instant is fed to the intake route's `scheduledFor`, which
 * runs it through `resolveSlotInstantForWrite` (the canonical ±tolerance
 * snap). It only needs to fall inside the target slot's capture zone, so a
 * sub-minute DST-offset slop is harmless — the snap collapses it onto the
 * exact canonical slot row.
 */

export interface DisplayedSlotSchedule {
  windowStart: string;
  windowEnd: string;
}

export interface ResolveDisplayedSlotInstantInput {
  /**
   * The card's current-window status. When its `status` is non-null the
   * card is surfacing that schedule's window today (in_window / late /
   * very_late), so the recorded dose is that window's slot today.
   *
   * v1.16.1 — `window` carries the matched dose band's anchor
   * (`timeOfDay`, a `timesOfDay` entry). It is the canonical slot time;
   * the schedule's `windowStart` stays only as the legacy fallback for
   * rows without `timesOfDay`, so a stale / degenerate window can no
   * longer mis-anchor the recorded dose.
   */
  currentWindowStatus: {
    status: "in_window" | "late" | "very_late" | null;
    schedule: DisplayedSlotSchedule | null;
    window?: { timeOfDay: string } | null;
  };
  /**
   * The server-computed next-due instant (`computeNextDueAt`, the canonical
   * recurrence engine). The card renders this when no window is currently
   * actionable; it is already a canonical slot instant.
   */
  nextDueAt: string | null | undefined;
  /** Wall-clock reference (injected for testability). */
  now: Date;
  /**
   * IANA timezone the card's day boundary is reasoned in. Berlin is the
   * last-resort fallback the card surfaces share; passing the user's
   * actual zone keeps the slot on the right calendar day across the rare
   * cross-midnight edge.
   */
  timeZone?: string;
}

/**
 * Build a UTC `Date` for `HH:MM` on `now`'s calendar day in `timeZone`.
 *
 * Computes the zone's offset at `now` from `Intl` parts and applies it, so
 * the result is the instant that reads as `HH:MM` local on today's date.
 * Exactness to the minute is not required downstream (the server snap has a
 * multi-hour tolerance), but this is correct to the minute regardless.
 */
function localHmTodayAsUtc(
  now: Date,
  timeZone: string,
  hour: number,
  minute: number,
): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Intl renders 24:xx for midnight in some engines; normalise to 0.
  const localHour = get("hour") % 24;

  const localNowAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    localHour,
    get("minute"),
    get("second"),
  );
  const offsetMs =
    Math.round((localNowAsUtc - now.getTime()) / 60_000) * 60_000;

  const localTargetAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    minute,
    0,
    0,
  );
  return new Date(localTargetAsUtc - offsetMs);
}

function parseHm(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Resolve the displayed dose's `scheduledFor` instant, or `null` when the
 * card cannot identify a specific slot (no current window AND no next-due —
 * e.g. a PRN medication). A `null` return preserves the legacy server
 * behaviour: the POST omits `scheduledFor` and the route handles the
 * unscheduled / PRN insert path.
 */
export function resolveDisplayedSlotInstant(
  input: ResolveDisplayedSlotInstantInput,
): Date | null {
  const {
    currentWindowStatus,
    nextDueAt,
    now,
    timeZone = DEFAULT_TIMEZONE,
  } = input;

  // The card surfaces the current/overdue dose band — record that band's
  // slot on today's calendar day. The matched band's `timeOfDay` is the
  // canonical dose anchor; `windowStart` is only the legacy fallback for
  // schedules without `timesOfDay`.
  if (currentWindowStatus.status && currentWindowStatus.schedule) {
    const anchor =
      currentWindowStatus.window?.timeOfDay ??
      currentWindowStatus.schedule.windowStart;
    const hm = parseHm(anchor);
    if (hm) return localHmTodayAsUtc(now, timeZone, hm.hour, hm.minute);
  }

  // Otherwise the card surfaces the next-due dose, already a canonical
  // slot instant from the server.
  if (nextDueAt) {
    const d = new Date(nextDueAt);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}
