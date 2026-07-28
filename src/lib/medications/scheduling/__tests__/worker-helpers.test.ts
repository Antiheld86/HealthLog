/**
 * v1.15.18 — `normaliseDoseWindows` coerces the persisted `dose_windows` JSON
 * into a clean `DoseWindowEntry[]`, dropping anything malformed so the band
 * paths never have to defend against an arbitrary JSON shape.
 */
import { describe, expect, it } from "vitest";

import {
  buildCanonicalSchedule,
  normaliseDoseWindows,
  resolveSlotWindowDurationMinutes,
  type WorkerScheduleRow,
} from "../worker-helpers";
import { DOSE_WINDOW_DEFAULTS } from "../dose-window-defaults";

describe("normaliseDoseWindows", () => {
  it("returns null for null / non-array input", () => {
    expect(normaliseDoseWindows(null)).toBeNull();
    expect(normaliseDoseWindows(undefined)).toBeNull();
    expect(normaliseDoseWindows("nope")).toBeNull();
    expect(normaliseDoseWindows({ timeOfDay: "07:00" })).toBeNull();
  });

  it("keeps a well-formed entry", () => {
    expect(
      normaliseDoseWindows([
        { timeOfDay: "07:00", start: "07:00", end: "09:00" },
      ]),
    ).toEqual([{ timeOfDay: "07:00", start: "07:00", end: "09:00" }]);
  });

  it("drops entries with start > end, bad HH:mm, or missing keys", () => {
    expect(
      normaliseDoseWindows([
        { timeOfDay: "07:00", start: "12:00", end: "07:00" }, // start > end
        { timeOfDay: "7:00", start: "07:00", end: "09:00" }, // bad HH:mm
        { timeOfDay: "19:00", start: "19:00" }, // missing end
        { timeOfDay: "08:00", start: "25:00", end: "26:00" }, // out of range
      ]),
    ).toBeNull();
  });

  it("keeps the good entries and drops the bad ones in a mixed array", () => {
    expect(
      normaliseDoseWindows([
        { timeOfDay: "07:00", start: "07:00", end: "09:00" }, // good
        { timeOfDay: "19:00", start: "20:00", end: "19:00" }, // start > end
      ]),
    ).toEqual([{ timeOfDay: "07:00", start: "07:00", end: "09:00" }]);
  });

  it("threads through buildCanonicalSchedule onto the canonical schedule", () => {
    const row: WorkerScheduleRow = {
      id: "s1",
      windowStart: "07:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["07:00"],
      reminderGraceMinutes: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      doseWindows: [{ timeOfDay: "07:00", start: "07:00", end: "09:00" }],
    };
    expect(buildCanonicalSchedule(row).doseWindows).toEqual([
      { timeOfDay: "07:00", start: "07:00", end: "09:00" },
    ]);
  });

  it("a row with no doseWindows yields null on the canonical schedule", () => {
    const row: WorkerScheduleRow = {
      id: "s1",
      windowStart: "07:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["07:00"],
      reminderGraceMinutes: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
    };
    expect(buildCanonicalSchedule(row).doseWindows).toBeNull();
  });
});

/**
 * `resolveSlotWindowDurationMinutes` — closes the bug where a
 * multi-time-of-day schedule's reminder tick reused the WHOLE
 * schedule's `windowEnd - windowStart` span for every individual
 * slot, silently giving each dose a grace period equal to the gap
 * between the schedule's earliest and latest dose instead of its own
 * configured window. Reproduces the real-world case that surfaced it:
 * two identically-*intended* once/twice-daily medications
 * (Lansoprazole: one 08:00 dose; Metoprolol: 08:00 + 18:00 doses)
 * resolving to wildly different per-slot durations (60min vs 600min)
 * purely because one schedule had a sibling dose.
 */
describe("resolveSlotWindowDurationMinutes", () => {
  it("single-time-of-day schedule: unchanged legacy windowEnd - windowStart", () => {
    const schedule: WorkerScheduleRow = {
      id: "s1",
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["08:00"],
      reminderGraceMinutes: null,
      rrule: null,
      rollingIntervalDays: null,
    };
    expect(resolveSlotWindowDurationMinutes(schedule, "08:00", null)).toBe(60);
  });

  it("REGRESSION (Lansoprazole real data): single 08:00-09:00 slot resolves to 60min, not inflated", () => {
    const schedule: WorkerScheduleRow = {
      id: "lansoprazole-schedule",
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["08:00"],
      reminderGraceMinutes: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
    };
    expect(resolveSlotWindowDurationMinutes(schedule, "08:00", null)).toBe(60);
  });

  it("REGRESSION (Metoprolol real data): a 08:00/18:00 schedule no longer gives the 08:00 slot a 600min window", () => {
    const schedule: WorkerScheduleRow = {
      id: "metoprolol-schedule",
      windowStart: "08:00",
      windowEnd: "18:00",
      daysOfWeek: null,
      timesOfDay: ["08:00", "18:00"],
      reminderGraceMinutes: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
    };
    const morning = resolveSlotWindowDurationMinutes(schedule, "08:00", null);
    const evening = resolveSlotWindowDurationMinutes(schedule, "18:00", null);
    expect(morning).toBeLessThan(600);
    expect(evening).toBeLessThan(600);
    expect(morning).toBe(DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes * 2);
    expect(evening).toBe(DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes * 2);
  });

  it("core requirement: an unconfigured dose resolves the SAME whether or not it has a sibling slot, once both use an explicit override", () => {
    const single: WorkerScheduleRow = {
      id: "single",
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["08:00"],
      reminderGraceMinutes: 180,
      rrule: null,
      rollingIntervalDays: null,
    };
    const multi: WorkerScheduleRow = {
      id: "multi",
      windowStart: "08:00",
      windowEnd: "18:00",
      daysOfWeek: null,
      timesOfDay: ["08:00", "18:00"],
      reminderGraceMinutes: 180,
      rrule: null,
      rollingIntervalDays: null,
    };
    // Same explicit reminderGraceMinutes, same slotTime — the presence
    // of Metoprolol-style sibling slot must not change the 08:00
    // dose's resolved duration at all.
    expect(resolveSlotWindowDurationMinutes(single, "08:00", null)).toBe(
      resolveSlotWindowDurationMinutes(multi, "08:00", null),
    );
    expect(resolveSlotWindowDurationMinutes(multi, "08:00", null)).toBe(180);
  });

  it("an explicit per-dose doseWindows entry wins over everything else, keyed by timeOfDay", () => {
    const schedule: WorkerScheduleRow = {
      id: "s1",
      windowStart: "08:00",
      windowEnd: "18:00",
      daysOfWeek: null,
      timesOfDay: ["08:00", "18:00"],
      reminderGraceMinutes: 180, // present but should be overridden for 08:00
      rrule: null,
      rollingIntervalDays: null,
    };
    const doseWindows = [
      { timeOfDay: "08:00", start: "07:30", end: "09:30" }, // 120min
    ];
    expect(
      resolveSlotWindowDurationMinutes(schedule, "08:00", doseWindows),
    ).toBe(120);
    // The 18:00 slot has no matching doseWindows entry, so it still
    // falls through to reminderGraceMinutes.
    expect(
      resolveSlotWindowDurationMinutes(schedule, "18:00", doseWindows),
    ).toBe(180);
  });

  it("caps the unconfigured-dose default at the minimum inter-slot gap so two close doses never overlap", () => {
    const schedule: WorkerScheduleRow = {
      id: "s1",
      windowStart: "08:00",
      windowEnd: "09:30", // legacy span irrelevant here — multi-slot ignores it
      daysOfWeek: null,
      timesOfDay: ["08:00", "09:30"], // only 90min apart — narrower than the 120min default
      reminderGraceMinutes: null,
      rrule: null,
      rollingIntervalDays: null,
    };
    const duration = resolveSlotWindowDurationMinutes(schedule, "08:00", null);
    expect(duration).toBe(90);
    expect(duration).toBeLessThan(DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes * 2);
  });

  it("caps by the midnight-wrap gap too, not just forward gaps", () => {
    const schedule: WorkerScheduleRow = {
      id: "s1",
      windowStart: "23:00",
      windowEnd: "23:30",
      daysOfWeek: null,
      timesOfDay: ["23:00", "23:30"], // 30min apart, wrapping close to midnight
      reminderGraceMinutes: null,
      rrule: null,
      rollingIntervalDays: null,
    };
    expect(resolveSlotWindowDurationMinutes(schedule, "23:00", null)).toBe(30);
  });
});
