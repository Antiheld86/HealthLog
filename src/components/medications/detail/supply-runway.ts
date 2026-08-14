/**
 * v1.15.20 — supply-runway estimate for the medication detail Übersicht.
 *
 * Pure helpers that turn the schedule snapshot the detail GET already
 * carries into an approximate doses-per-day figure, so the Übersicht tab
 * can render "lasts about N more days" from the inventory remaining-doses
 * count without a new endpoint. The estimate is deliberately coarse
 * (calendar months ≈ 30 days) — the copy says "about" and the Bestand tab
 * stays the authoritative per-item readout.
 */

import { parseScheduleRecurrence } from "@/lib/medication-schedule";

/** The schedule fields the runway estimate reads. */
export interface RunwaySchedule {
  windowStart: string;
  daysOfWeek: string | null;
  timesOfDay?: string[];
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  /**
   * v1.37.19 (#219 parity) — per-slot units override as a plain number
   * (the wire shape). `null`/`undefined` inherits the medication-level
   * `unitsPerDose`, exactly like the consumption path's resolver.
   */
  unitsPerDose?: number | null;
}

/**
 * Approximate doses per day for ONE schedule: times-of-day count, scaled
 * down by the cadence (rolling interval, weekly day picks + interval
 * weeks, monthly/yearly RRULEs).
 */
function scheduleDailyDoseCount(s: RunwaySchedule): number {
  const times =
    s.timesOfDay && s.timesOfDay.length > 0 ? s.timesOfDay.length : 1;
  if (typeof s.rollingIntervalDays === "number" && s.rollingIntervalDays >= 1) {
    return times / s.rollingIntervalDays;
  }
  const rrule = s.rrule ?? "";
  if (/FREQ=MONTHLY/.test(rrule)) {
    return times / 30;
  }
  if (/FREQ=YEARLY/.test(rrule)) {
    return times / 365;
  }
  // FREQ=WEEKLY;BYDAY=…;INTERVAL=… is the modern weekly encoding (the
  // create path stores the cadence on the rrule and leaves daysOfWeek
  // empty). Honour the BYDAY pick count and the week INTERVAL: a
  // once-weekly injection is one dose per 7 days, a bi-weekly one per
  // 14. Without this branch a weekly rrule fell through to the legacy
  // daysOfWeek fallback below with daysPerWeek=7, over-estimating the
  // rate ~7× (≈14× bi-weekly) and firing low-stock alerts far too early.
  if (/FREQ=WEEKLY/.test(rrule)) {
    const byday = /BYDAY=([^;]+)/.exec(rrule);
    const bydayCount =
      byday && byday[1].length > 0 ? byday[1].split(",").length : 1;
    const intervalMatch = /INTERVAL=(\d+)/.exec(rrule);
    const interval =
      intervalMatch && Number(intervalMatch[1]) >= 1
        ? Number(intervalMatch[1])
        : 1;
    return (times * bydayCount) / (7 * interval);
  }
  const { daysOfWeek, intervalWeeks } = parseScheduleRecurrence(s.daysOfWeek);
  const daysPerWeek = daysOfWeek.length > 0 ? daysOfWeek.length : 7;
  const weeks = intervalWeeks >= 1 ? intervalWeeks : 1;
  return (times * daysPerWeek) / (7 * weeks);
}

/**
 * Approximate doses per day across every schedule.
 */
export function estimateDailyDoseCount(schedules: RunwaySchedule[]): number {
  let perDay = 0;
  for (const s of schedules) {
    perDay += scheduleDailyDoseCount(s);
  }
  return perDay;
}

/**
 * v1.37.19 (#219 parity) — approximate inventory UNITS consumed per day,
 * honouring each slot's own `unitsPerDose` where set. The pre-fix figure
 * multiplied the dose rate by the medication-level units alone, which
 * over- or under-stated the burn rate for any medication whose slots
 * carry different doses (a whole tablet in the morning, a half at noon).
 */
export function estimateDailyUnitsCount(
  schedules: RunwaySchedule[],
  medicationUnitsPerDose: number,
): number {
  const fallback = medicationUnitsPerDose > 0 ? medicationUnitsPerDose : 1;
  let perDayUnits = 0;
  for (const s of schedules) {
    const perSlot =
      typeof s.unitsPerDose === "number" && s.unitsPerDose > 0
        ? s.unitsPerDose
        : fallback;
    perDayUnits += scheduleDailyDoseCount(s) * perSlot;
  }
  return perDayUnits;
}

/**
 * The schedule-weighted average units one dose consumes — the divisor that
 * turns a units pool into an honest doses-remaining figure for a
 * medication with per-slot doses. Falls back to the medication level when
 * no schedule derives a consumption rate.
 */
export function effectiveUnitsPerDose(
  schedules: RunwaySchedule[],
  medicationUnitsPerDose: number,
): number {
  const fallback = medicationUnitsPerDose > 0 ? medicationUnitsPerDose : 1;
  const perDay = estimateDailyDoseCount(schedules);
  if (perDay <= 0) return fallback;
  const perDayUnits = estimateDailyUnitsCount(
    schedules,
    medicationUnitsPerDose,
  );
  return perDayUnits > 0 ? perDayUnits / perDay : fallback;
}

/**
 * v1.37.19 (#219 parity) — whole days a UNITS pool covers under the
 * slot-aware burn rate, or `null` when no consuming schedule exists.
 * Zero units with a consuming schedule is honestly 0 days.
 */
export function estimateUnitsRunwayDays(
  unitsRemaining: number,
  schedules: RunwaySchedule[],
  medicationUnitsPerDose: number,
): number | null {
  const perDayUnits = estimateDailyUnitsCount(
    schedules,
    medicationUnitsPerDose,
  );
  if (perDayUnits <= 0) return null;
  return Math.floor(Math.max(0, unitsRemaining) / perDayUnits);
}

/**
 * Whole days the remaining supply covers, or `null` when no estimate is
 * possible (no supply, no consuming schedule).
 */
export function estimateRunwayDays(
  dosesRemaining: number,
  schedules: RunwaySchedule[],
): number | null {
  if (dosesRemaining <= 0) return null;
  const perDay = estimateDailyDoseCount(schedules);
  if (perDay <= 0) return null;
  return Math.floor(dosesRemaining / perDay);
}

/**
 * v1.17.0 — one dose-interval in whole days for a cadence: the inverse
 * of the daily-dose rate, rounded up. ≈1 for a daily med, ≈7 for a
 * weekly injection, ≈30 for a monthly RRULE. Returns `null` for a
 * schedule with no derivable consumption (as-needed / empty).
 */
export function cadenceIntervalDays(
  schedules: RunwaySchedule[],
): number | null {
  const perDay = estimateDailyDoseCount(schedules);
  if (perDay <= 0) return null;
  return Math.ceil(1 / perDay);
}

/**
 * v1.17.0 — reorder-lead-aware low-stock trigger threshold in days.
 *
 * The bare `lowStockRunwayDays` floor fired the alert only when the
 * runway dropped below it; for a sparse cadence (a weekly injection's
 * 7-day floor ≈ one dose-interval) that warning landed with ~1 dose
 * left — too late to reorder. The effective trigger widens the floor to
 * cover the reorder lead PLUS one dose-interval:
 *
 *   trigger = max(lowStockRunwayDays, leadDays + cadenceIntervalDays)
 *
 * so the alert lands before the LAST dose for any cadence. Because the
 * result is `max(...)` over the user's own floor, it NEVER shrinks
 * anyone's current threshold — only widens it when the lead + cadence
 * demand more headroom. A schedule with no derivable cadence falls back
 * to the bare floor (it has no runway anyway, so it never fires).
 */
export function lowStockTriggerDays(input: {
  lowStockRunwayDays: number;
  leadDays: number;
  schedules: RunwaySchedule[];
}): number {
  const interval = cadenceIntervalDays(input.schedules);
  if (interval === null) return input.lowStockRunwayDays;
  return Math.max(input.lowStockRunwayDays, input.leadDays + interval);
}

/** v1.17.0 — informational vs actionable low-stock presentation state. */
export type LowStockState = "running_low" | "last_dose";

/**
 * v1.17.0 — classify a runway against its cadence + trigger for the
 * card / push copy. Returns `null` when the supply is comfortably above
 * the trigger (no notice). `"last_dose"` when the runway is down to one
 * dose-interval (informational — about to take the final dose);
 * `"running_low"` otherwise within the trigger (actionable — reorder
 * now). `last_dose` wins when both apply so the final-dose case reads
 * as the calmer, more specific line.
 */
export function classifyLowStockState(input: {
  runwayDays: number;
  triggerDays: number;
  schedules: RunwaySchedule[];
}): LowStockState | null {
  if (input.runwayDays > input.triggerDays) return null;
  const interval = cadenceIntervalDays(input.schedules);
  if (interval !== null && input.runwayDays <= interval) return "last_dose";
  return "running_low";
}

/** A calendar date as a UTC-midnight `Date` — the copy renders day-only. */
function addDaysUtc(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * v1.17.0 — the two concrete dates the low-stock copy surfaces:
 *   runsOutOn = today + runwayDays  (supply depletes)
 *   reorderBy = runsOutOn − leadDays (order by this date to avoid a gap)
 * Both are clamped to never precede `today` (a deep low-stock state can
 * push `reorderBy` into the past — surface today instead of a past date).
 */
export function supplyRunwayDates(input: {
  today: Date;
  runwayDays: number;
  leadDays: number;
}): { runsOutOn: Date; reorderBy: Date } {
  const runsOutOn = addDaysUtc(input.today, Math.max(0, input.runwayDays));
  const reorderRaw = addDaysUtc(runsOutOn, -input.leadDays);
  const reorderBy =
    reorderRaw < input.today ? new Date(input.today) : reorderRaw;
  return { runsOutOn, reorderBy };
}
