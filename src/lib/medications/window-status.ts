/**
 * v1.4.37 W4b — shared current-window status helper for medication
 * detail cards.
 *
 * Both the generic `<MedicationCard>` and the GLP-1 variant
 * (`<Glp1MedicationCard>`) need to paint the same coloured "take now /
 * overdue / very overdue" pill at the top of their detail surface. The
 * logic was historically inlined in the generic card only, which produced
 * a visible asymmetry between the two variants (v1.4.37 UX audit item 11).
 *
 * Lifting the schedule-window math into one helper guarantees both card
 * variants stay byte-equivalent for the status row — same thresholds,
 * same in-window / late / very-late tiering, same overnight-window
 * handling, same "don't show in-window if last intake already covered
 * this window today" guard. The GLP-1 schedule shape carries the same
 * `windowStart` / `windowEnd` / `daysOfWeek` fields as the generic
 * schedule, so the helper accepts any schedule that satisfies the
 * minimal `ScheduleWindowInput` shape.
 *
 * v1.16.1 — the dose-band model becomes the canonical source. When a
 * schedule carries `timesOfDay`, every status decision derives from
 * per-dose on-time bands — the explicit `doseWindows` entry for the
 * matching dose when present, else `timeOfDay ±` the default daily
 * on-time half-width. The legacy `windowStart` / `windowEnd` pair is
 * consulted ONLY for rows without `timesOfDay`; a stale or degenerate
 * window (e.g. `07:00 / 07:00` left behind by an old write path while
 * the times moved to `09:00 / 21:00`) can no longer paint a take-now
 * pill at 07:00 or mis-anchor the recorded slot. The matched band rides
 * on the result (`window`) so the pill text and the displayed-slot
 * resolution read the SAME band the status came from.
 *
 * v1.15.20 — three model fixes (kept):
 *   - the wall-clock conversion takes the user's IANA timezone (default
 *     `Europe/Berlin` so existing call sites compile + behave unchanged;
 *     threading the real user timezone through the cards is the follow-up);
 *   - a degenerate `windowStart === windowEnd` schedule (a single dose
 *     time echoed into both fields) is a POINT window widened by the
 *     default daily on-time half-width — it previously fell into the
 *     overnight branch and read as a 24 h always-in-window band;
 *   - passed-dose counting counts the schedule's `timesOfDay` doses, not
 *     schedule rows, so a two-dose row ("08:00" + "20:00") expects two
 *     intake events before the overdue pill is suppressed.
 */
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";
import {
  localDayIndex,
  wallClockInTz,
  type WallClockParts,
} from "@/lib/tz/wall-clock";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/** One explicit per-dose on-time window as the API serialises it. */
export interface DoseWindowEntryInput {
  timeOfDay: string;
  start: string;
  end: string;
}

export interface ScheduleWindowInput {
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
  /**
   * v1.15.20 — first-class dose times. Optional so legacy fixtures and the
   * existing card call sites compile unchanged; when absent the schedule
   * row falls back to the single legacy window (the pre-v1.16.1 behaviour).
   */
  timesOfDay?: string[];
  /**
   * v1.16.1 — explicit per-dose on-time windows (the detail page's
   * Zeitplan editor writes them). Only read for doses listed in
   * `timesOfDay`; malformed entries fall back to the default derivation.
   */
  doseWindows?: DoseWindowEntryInput[] | null;
}

export type MedicationWindowStatus = "in_window" | "late" | "very_late" | null;

/**
 * The dose band that produced a non-null status. `timeOfDay` is the dose
 * anchor (a `timesOfDay` entry, or `windowStart` on a legacy row); `start`
 * / `end` are the HH:mm band bounds for display.
 */
export interface MatchedDoseWindow {
  timeOfDay: string;
  start: string;
  end: string;
}

export interface CurrentWindowStatus<Schedule extends ScheduleWindowInput> {
  status: MedicationWindowStatus;
  schedule: Schedule | null;
  /** Non-null exactly when `status` is non-null. */
  window: MatchedDoseWindow | null;
  /**
   * v1.16.9 — non-null when the matched schedule is a DAY-SCALE cadence
   * (weekly / N-weekly injectable) and a recent actioned take exists
   * inside the current cadence period but on an earlier day. The dose is
   * already on board: the card must render last-dose context instead of
   * the "take now" / overdue prompt — a full take prompt on the slot day
   * is a double-dose prompt. The value is the whole local days since
   * that take, so the pill copy stays factual (the take may have been an
   * early shot OR the previous slot served late — the day distance does
   * not distinguish). Always null when `status` is null.
   */
  takenEarlyDaysAgo: number | null;
}

/**
 * v1.16.6 — the server's display-due verdict (`nextDueAt` +
 * `nextDueOverdue` on the list payload, computed by `computeDisplayDue`
 * from the band model: next unresolved slot + its overdue tail). When a
 * caller threads it, the pill status is gated on it so the pill can NEVER
 * read more overdue than the next-due line. Without the gate a rolling
 * cadence (`daysOfWeek` empty) re-mints its dose band every local day and
 * escalates to late / very_late each afternoon even while the next
 * unresolved slot sits days in the future.
 */
export interface NextDueGate {
  /** The display-due instant (`nextDueAt` parsed). */
  at: Date;
  /** True when that instant is an OPEN overdue slot (`nextDueOverdue`). */
  overdue: boolean;
}

/**
 * Minute-of-day an observer in the target zone reads off the wall clock.
 * Every band comparison below is minute-of-day arithmetic, so this is the
 * only projection the status math needs.
 */
function minuteOfDay(parts: WallClockParts): number {
  return parts.hour * 60 + parts.minute;
}

/** True when two wall clocks name the same local calendar day. */
function sameLocalDay(a: WallClockParts, b: WallClockParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (
    !Number.isFinite(h) ||
    !Number.isFinite(m) ||
    h < 0 ||
    h > 23 ||
    m < 0 ||
    m > 59
  ) {
    return 0;
  }
  return h * 60 + m;
}

function minutesToHm(mins: number): string {
  const clamped = Math.min(Math.max(mins, 0), 24 * 60 - 1);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

interface DoseWindowBounds {
  /** Dose anchor for slot resolution + UI labels. */
  timeOfDay: string;
  startMins: number;
  /** May exceed 24 h × 60 for a legacy overnight window (end wrapped past midnight). */
  endMins: number;
  /** HH:mm display strings (the legacy branch keeps the raw schedule strings). */
  startHm: string;
  endHm: string;
}

/**
 * Resolve a legacy (no `timesOfDay`) schedule window into minute-of-day
 * bounds with two special shapes handled:
 *
 *   - `end === start` — a degenerate POINT window (a single dose time echoed
 *     into both fields). Previously this fell into the overnight branch and
 *     became a 24 h always-in-window band; it now widens symmetrically by
 *     the default daily on-time half-width, clamped to the same local day
 *     so the overnight arithmetic downstream stays untouched.
 *   - `end < start` — a genuine overnight window; the end wraps past
 *     midnight (`endMins > 1440`), matching the historical behaviour.
 */
function resolveLegacyWindowBounds(schedule: ScheduleWindowInput): {
  startMins: number;
  endMins: number;
} {
  let startMins = parseTimeToMinutes(schedule.windowStart);
  let endMins = parseTimeToMinutes(schedule.windowEnd);

  if (endMins === startMins) {
    const half = DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes;
    startMins = Math.max(0, startMins - half);
    endMins = Math.min(24 * 60 - 1, endMins + half);
  } else if (endMins < startMins) {
    endMins += 24 * 60;
  }

  return { startMins, endMins };
}

/**
 * v1.16.1 — the canonical band resolution. A schedule with `timesOfDay`
 * yields ONE band per dose: the explicit `doseWindows` entry when present
 * and well-formed, else `timeOfDay ±` the default daily on-time
 * half-width (clamped to the local day). A schedule without `timesOfDay`
 * yields the single legacy window. The legacy `windowStart` / `windowEnd`
 * NEVER shape a band once `timesOfDay` exists — stale or degenerate
 * windows must not drive the status or the recorded slot.
 */
function resolveDoseWindows(schedule: ScheduleWindowInput): DoseWindowBounds[] {
  const times = (schedule.timesOfDay ?? []).filter((t) => HHMM_RE.test(t));
  if (times.length > 0) {
    const half = DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes;
    return times.map((timeOfDay) => {
      const explicit = Array.isArray(schedule.doseWindows)
        ? schedule.doseWindows.find(
            (w) =>
              w &&
              w.timeOfDay === timeOfDay &&
              HHMM_RE.test(w.start) &&
              HHMM_RE.test(w.end) &&
              parseTimeToMinutes(w.start) <= parseTimeToMinutes(w.end),
          )
        : undefined;
      if (explicit) {
        return {
          timeOfDay,
          startMins: parseTimeToMinutes(explicit.start),
          endMins: parseTimeToMinutes(explicit.end),
          startHm: explicit.start,
          endHm: explicit.end,
        };
      }
      const anchor = parseTimeToMinutes(timeOfDay);
      const startMins = Math.max(0, anchor - half);
      const endMins = Math.min(24 * 60 - 1, anchor + half);
      return {
        timeOfDay,
        startMins,
        endMins,
        startHm: minutesToHm(startMins),
        endHm: minutesToHm(endMins),
      };
    });
  }

  const { startMins, endMins } = resolveLegacyWindowBounds(schedule);
  return [
    {
      timeOfDay: schedule.windowStart,
      startMins,
      endMins,
      // Keep the raw schedule strings for display so legacy pills render
      // byte-identically to the pre-band model.
      startHm: schedule.windowStart,
      endHm: schedule.windowEnd,
    },
  ];
}

const STATUS_PRIORITY = { in_window: 3, late: 2, very_late: 1 } as const;

function bandStatus(
  band: DoseWindowBounds,
  nowMins: number,
  lateMinutes: number,
  missedMinutes: number,
): Exclude<MedicationWindowStatus, null> | null {
  // Handle legacy overnight windows (wrapped end past midnight).
  const adjustedNow =
    nowMins < band.startMins && band.endMins > 24 * 60
      ? nowMins + 24 * 60
      : nowMins;

  if (adjustedNow >= band.startMins && adjustedNow <= band.endMins) {
    return "in_window";
  }

  const minutesPastEnd = adjustedNow - band.endMins;
  if (minutesPastEnd > 0 && minutesPastEnd <= lateMinutes) return "late";
  if (minutesPastEnd > lateMinutes && minutesPastEnd <= missedMinutes) {
    return "very_late";
  }
  return null;
}

function getScheduleStatus(
  schedule: ScheduleWindowInput,
  nowParts: WallClockParts,
  lateMinutes: number,
  missedMinutes: number,
): {
  status: Exclude<MedicationWindowStatus, null>;
  band: DoseWindowBounds;
} | null {
  const nowMins = minuteOfDay(nowParts);
  let best: {
    status: Exclude<MedicationWindowStatus, null>;
    band: DoseWindowBounds;
  } | null = null;
  for (const band of resolveDoseWindows(schedule)) {
    const status = bandStatus(band, nowMins, lateMinutes, missedMinutes);
    if (!status) continue;
    if (!best || STATUS_PRIORITY[status] > STATUS_PRIORITY[best.status]) {
      best = { status, band };
    }
  }
  return best;
}

/**
 * v1.16.9 — the attribution module's bounded early grace: a take
 * slightly before the on-time band still credits the slot, so the pill
 * suppression must accept it too (an 08:42 take for a 09:00-window slot
 * must not leave "take now" burning at 09:05). Read from the shared
 * dose-window-defaults leaf — the same constant the write-path
 * attribution derives `EARLY_GRACE_MS` from — so the two surfaces can
 * never disagree.
 */
const EARLY_GRACE_MINUTES = DOSE_WINDOW_DEFAULTS.earlyGraceMinutes;

function isLastIntakeInBand(
  lastTakenAt: string | null,
  band: DoseWindowBounds,
  nowParts: WallClockParts,
  tz: string,
  /**
   * Lower bound (minutes-of-day) the early grace may not cross — the end
   * of the schedule's previous dose band, so a take belonging to the
   * prior dose never suppresses this one. Defaults to 0 (no earlier band).
   */
  earlyFloorMins = 0,
): boolean {
  if (!lastTakenAt) return false;

  const intake = wallClockInTz(new Date(lastTakenAt), tz);

  // Must be same calendar day
  if (!sameLocalDay(intake, nowParts)) return false;

  const intakeMins = minuteOfDay(intake);

  // Handle legacy overnight windows
  const adjustedIntake =
    intakeMins < band.startMins && band.endMins > 24 * 60
      ? intakeMins + 24 * 60
      : intakeMins;

  const startWithGrace = Math.max(
    band.startMins - EARLY_GRACE_MINUTES,
    earlyFloorMins,
    0,
  );
  return adjustedIntake >= startWithGrace && adjustedIntake <= band.endMins;
}

/**
 * v1.16.9 — day-scale cadence detection for the taken-early downgrade.
 *
 * A schedule whose dose days sit ≥ 2 days apart (a single weekday, a
 * sparse Mo/Th pattern, an N-weekly interval) is day-scale: one dose
 * covers a multi-day period, so a take earlier in the period must inform
 * the slot-day pill. Daily / near-daily patterns (minute-scale) return
 * `dayScale: false` — their period is a day and the same-day band checks
 * already cover them. `periodDays` is the smallest gap between
 * consecutive dose days (the span one dose covers).
 */
function dayScaleCadence(daysOfWeek: string | null): {
  dayScale: boolean;
  periodDays: number;
} {
  const recurrence = parseScheduleRecurrence(daysOfWeek);
  const days = [...new Set(recurrence.daysOfWeek)].sort((a, b) => a - b);
  if (days.length === 0) return { dayScale: false, periodDays: 0 };
  const intervalWeeks = Math.max(1, recurrence.intervalWeeks ?? 1);
  if (days.length === 1) {
    return { dayScale: true, periodDays: 7 * intervalWeeks };
  }
  let minGap = Infinity;
  for (let i = 1; i < days.length; i++) {
    minGap = Math.min(minGap, days[i] - days[i - 1]);
  }
  // Wrap from the week's last dose day to the next cycle's first.
  const wrapGap = days[0] + 7 * intervalWeeks - days[days.length - 1];
  minGap = Math.min(minGap, wrapGap);
  return { dayScale: minGap >= 2, periodDays: minGap };
}

/**
 * Whole local days since the last actioned take when it lies on an
 * EARLIER local day inside the current cadence period — the shape the
 * taken-early downgrade fires on — else `null`. A same-day take is the
 * in-band suppression's job; a take a full period (or more) ago is the
 * previous cycle's dose. The day count rides into the pill copy, which
 * stays neutral ("last dose {n} days ago"): the period may have opened
 * with an early shot OR the previous slot served late, and the distance
 * alone cannot tell the two apart.
 */
function earlyTakeDaysAgo(
  lastTakenAt: string | null,
  nowParts: WallClockParts,
  tz: string,
  periodDays: number,
): number | null {
  if (!lastTakenAt || periodDays < 2) return null;
  const intake = wallClockInTz(new Date(lastTakenAt), tz);
  const diff = localDayIndex(nowParts) - localDayIndex(intake);
  return diff >= 1 && diff < periodDays ? diff : null;
}

/**
 * Count how many doses are past their band today, honouring the
 * recurrence's allowed days-of-week. Used by both cards to suppress
 * "overdue" pills once the user has already covered every passed dose
 * with intake events for the day.
 *
 * v1.16.1 — counts per-dose BANDS: each `timesOfDay` dose passes when its
 * own on-time band end has passed, so a 09:00 / 21:00 row reads ONE
 * passed dose at noon (not two). A row without `timesOfDay` (legacy
 * shape) keeps the single-window behaviour, including the degenerate
 * point-window resolution; a wrapped overnight end (> 1440) keeps the raw
 * minute comparison so an overnight window never reads as "passed"
 * within the same local day, exactly as before.
 */
function countPassedDoses<Schedule extends ScheduleWindowInput>(
  schedules: Schedule[],
  nowParts: WallClockParts,
): number {
  const nowMins = minuteOfDay(nowParts);
  return schedules.reduce((sum, s) => {
    const recurrence = parseScheduleRecurrence(s.daysOfWeek);
    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(nowParts.weekday)
    ) {
      return sum;
    }
    const passed = resolveDoseWindows(s).filter((band) => {
      // Same-day end bound: a wrapped overnight end (> 1440) keeps the
      // raw minute value so the comparison matches the historical
      // behaviour (it never passes within the same local day).
      const endMins =
        band.endMins > 24 * 60 ? band.endMins - 24 * 60 : band.endMins;
      return nowMins > endMins;
    }).length;
    return sum + passed;
  }, 0);
}

/**
 * Reduce a list of schedules into the most actionable window status
 * for the card header pill. Returns `null` status when the medication
 * is paused, no dose band is currently in/past its window, or every
 * overdue dose is already covered by today's intake events.
 *
 * Priority: in_window > late > very_late. Suppresses an `in_window`
 * status when the last intake already falls inside the matched band so
 * the pill doesn't nag after the user took the dose.
 *
 * `now` is the real "now" instant — NOT a pre-shifted wall clock. The
 * helper decomposes it in `tz` itself, so caller and helper can no longer
 * disagree about which zone the comparison runs in. Callers used to pass a
 * `Date` fabricated by rendering the instant in the target zone and
 * re-parsing it as host-local; when that fabricated wall clock landed in
 * the HOST zone's spring-forward gap the engine silently advanced it an
 * hour, so a dose inside its window could read late and a just-taken dose
 * could fail to suppress the take-now pill. Passing the instant removes
 * that class outright.
 */
export function reduceCurrentWindowStatus<
  Schedule extends ScheduleWindowInput,
>(options: {
  schedules: Schedule[];
  /** The real current instant; decomposed in `tz` internally. */
  now: Date;
  lateMinutes: number;
  missedMinutes: number;
  active: boolean;
  lastTakenAt: string | null;
  /**
   * v1.16.9 — number of ACTIONED intake events today (taken or
   * explicitly skipped). The server list feeder counts only actioned
   * rows: the dashboard projector mints a pending row for every slot of
   * the day, so an all-rows count covered every passed dose after any
   * dashboard visit and the overdue pill went dark nondeterministically.
   */
  todayEventCount: number;
  /** IANA timezone the status math reasons in; defaults to Berlin. */
  tz?: string;
  /**
   * v1.16.6 — the server display-due gate. `undefined` keeps the legacy
   * purely band-derived behaviour (callers without the list payload);
   * `null` means the server found NO upcoming slot (paused / ended /
   * one-shot past) so no pill renders at all. With a gate present:
   *   - `overdue: false` (next unresolved slot in the future) suppresses
   *     late / very_late outright and allows in_window only when the due
   *     instant falls on the current local day — a rolling cadence whose
   *     next dose is tomorrow stays calm today;
   *   - `overdue: true` keeps the band-derived escalation (the slot is
   *     genuinely in its catch-up tail).
   */
  nextDue?: NextDueGate | null;
}): CurrentWindowStatus<Schedule> {
  const {
    schedules,
    now,
    lateMinutes,
    missedMinutes,
    active,
    lastTakenAt,
    todayEventCount,
    tz = DEFAULT_TIMEZONE,
    nextDue,
  } = options;
  const nowParts = wallClockInTz(now, tz);

  const none: CurrentWindowStatus<Schedule> = {
    status: null,
    schedule: null,
    window: null,
    takenEarlyDaysAgo: null,
  };
  if (!active) return none;
  if (nextDue === null) return none;

  const passedDoseCount = countPassedDoses(schedules, nowParts);
  const hasUncoveredOverdue = todayEventCount < passedDoseCount;

  // Display-due gate (see the option's doc above). Computed once: it does
  // not vary per schedule row — the server already reduced the rows to one
  // verdict.
  const dueIsToday =
    nextDue != null && sameLocalDay(wallClockInTz(nextDue.at, tz), nowParts);

  return schedules.reduce<CurrentWindowStatus<Schedule>>((best, s) => {
    const hit = getScheduleStatus(s, nowParts, lateMinutes, missedMinutes);
    if (!hit) return best;
    // The pill must never read more overdue than the next-due line: a
    // future (non-overdue) display-due suppresses every overdue tier, and
    // allows the take-now pill only on the due day itself.
    if (nextDue != null && !nextDue.overdue) {
      if (hit.status !== "in_window") return best;
      if (!dueIsToday) return best;
    }
    // Don't show late/very_late if all overdue doses are covered by
    // intake events for the day.
    if (hit.status !== "in_window" && !hasUncoveredOverdue) return best;
    // Don't show in_window if last intake is already within this band
    // today (including the bounded early grace, floored at the end of
    // the schedule's previous dose band so a prior dose's take never
    // suppresses this one).
    const earlyFloorMins = resolveDoseWindows(s).reduce(
      (floor, b) =>
        b.endMins <= hit.band.startMins && b.endMins > floor
          ? b.endMins
          : floor,
      0,
    );
    if (
      hit.status === "in_window" &&
      isLastIntakeInBand(lastTakenAt, hit.band, nowParts, tz, earlyFloorMins)
    ) {
      return best;
    }
    if (
      !best.status ||
      STATUS_PRIORITY[hit.status] > STATUS_PRIORITY[best.status]
    ) {
      // v1.16.9 — day-scale early-take downgrade: a weekly injectable
      // taken days before its slot day is already on board, so the pill
      // must carry last-dose context instead of prompting a full take
      // (a "Jetzt einnehmen" / overdue prompt here is a double-dose
      // prompt). The server next-due stays canonical — only the pill's
      // framing changes; the day count rides along for the copy.
      const cadence = dayScaleCadence(s.daysOfWeek);
      const takenEarlyDaysAgo = cadence.dayScale
        ? earlyTakeDaysAgo(lastTakenAt, nowParts, tz, cadence.periodDays)
        : null;
      return {
        status: hit.status,
        schedule: s,
        window: {
          timeOfDay: hit.band.timeOfDay,
          start: hit.band.startHm,
          end: hit.band.endHm,
        },
        takenEarlyDaysAgo,
      };
    }
    return best;
  }, none);
}
