/**
 * v1.15.18 — `normaliseDoseWindows` coerces the persisted `dose_windows` JSON
 * into a clean `DoseWindowEntry[]`, dropping anything malformed so the band
 * paths never have to defend against an arbitrary JSON shape.
 */
import { describe, expect, it } from "vitest";

import {
  buildCanonicalSchedule,
  normaliseDoseWindows,
  resolveSlotPhaseWindow,
  type WorkerScheduleRow,
} from "../worker-helpers";

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

  it("normalises an empty legacy daily row to its windowStart slot", () => {
    const row: WorkerScheduleRow = {
      id: "legacy",
      windowStart: "07:30",
      windowEnd: "08:30",
      daysOfWeek: null,
      timesOfDay: [],
      reminderGraceMinutes: null,
      rrule: null,
      rollingIntervalDays: null,
    };

    expect(buildCanonicalSchedule(row).timesOfDay).toEqual(["07:30"]);
  });
});

describe("resolveSlotPhaseWindow", () => {
  const base: WorkerScheduleRow = {
    id: "schedule-1",
    windowStart: "08:00",
    windowEnd: "09:00",
    daysOfWeek: null,
    timesOfDay: ["08:00"],
    reminderGraceMinutes: null,
    rrule: "FREQ=DAILY",
    rollingIntervalDays: null,
  };
  const utcSlot = new Date("2026-07-28T08:00:00.000Z");

  it("preserves a legacy single-slot schedule window", () => {
    expect(resolveSlotPhaseWindow(base, "08:00", null, utcSlot, "UTC")).toEqual(
      {
        start: new Date("2026-07-28T08:00:00.000Z"),
        end: new Date("2026-07-28T09:00:00.000Z"),
      },
    );
  });

  it("uses the shared post-slot default for each unconfigured sibling", () => {
    const schedule = {
      ...base,
      windowEnd: "18:00",
      timesOfDay: ["08:00", "18:00"],
    };
    expect(
      resolveSlotPhaseWindow(schedule, "08:00", null, utcSlot, "UTC"),
    ).toEqual({
      start: utcSlot,
      end: new Date("2026-07-28T09:00:00.000Z"),
    });
    const eveningSlot = new Date("2026-07-28T18:00:00.000Z");
    expect(
      resolveSlotPhaseWindow(schedule, "18:00", null, eveningSlot, "UTC"),
    ).toEqual({
      start: eveningSlot,
      end: new Date("2026-07-28T19:00:00.000Z"),
    });
  });

  it("uses a configured reminder grace instead of the legacy span", () => {
    expect(
      resolveSlotPhaseWindow(
        { ...base, reminderGraceMinutes: 45 },
        "08:00",
        null,
        utcSlot,
        "UTC",
      ),
    ).toEqual({
      start: utcSlot,
      end: new Date("2026-07-28T08:45:00.000Z"),
    });
  });

  it("honours a valid explicit range even when it excludes the nominal slot", () => {
    expect(
      resolveSlotPhaseWindow(
        base,
        "08:00",
        [{ timeOfDay: "08:00", start: "09:00", end: "10:00" }],
        utcSlot,
        "UTC",
      ),
    ).toEqual({
      start: new Date("2026-07-28T09:00:00.000Z"),
      end: new Date("2026-07-28T10:00:00.000Z"),
    });
  });

  it("caps the default phase grace at the next sibling", () => {
    expect(
      resolveSlotPhaseWindow(
        { ...base, timesOfDay: ["08:00", "08:30"] },
        "08:00",
        null,
        utcSlot,
        "UTC",
      ),
    ).toEqual({
      start: utcSlot,
      end: new Date("2026-07-28T08:30:00.000Z"),
    });
  });

  it("keeps a spring-forward-normalized sibling cap monotonic", () => {
    const slot = new Date("2026-03-29T01:30:00.000Z"); // requested 02:30 -> 03:30
    const window = resolveSlotPhaseWindow(
      { ...base, timesOfDay: ["02:30", "03:00"] },
      "02:30",
      null,
      slot,
      "Europe/Berlin",
    );

    expect(window).toEqual({ start: slot, end: slot });
    expect(window.end.getTime()).toBeGreaterThanOrEqual(window.start.getTime());
  });

  it("materialises configured bounds as wall-clock instants across DST", () => {
    const berlinSlot = new Date("2026-03-29T00:30:00.000Z"); // 01:30 CET
    expect(
      resolveSlotPhaseWindow(
        {
          ...base,
          windowStart: "01:30",
          windowEnd: "03:30",
          timesOfDay: ["01:30"],
        },
        "01:30",
        null,
        berlinSlot,
        "Europe/Berlin",
      ),
    ).toEqual({
      start: new Date("2026-03-29T00:30:00.000Z"),
      end: new Date("2026-03-29T01:30:00.000Z"),
    });
  });

  it("places a late-night overnight end on the following local day", () => {
    const slot = new Date("2026-07-28T23:30:00.000Z");
    expect(
      resolveSlotPhaseWindow(
        {
          ...base,
          windowStart: "23:30",
          windowEnd: "00:15",
          timesOfDay: ["23:30"],
        },
        "23:30",
        null,
        slot,
        "UTC",
      ),
    ).toEqual({
      start: new Date("2026-07-28T23:30:00.000Z"),
      end: new Date("2026-07-29T00:15:00.000Z"),
    });
  });

  it("places an after-midnight overnight start on the previous local day", () => {
    const slot = new Date("2026-07-29T00:30:00.000Z");
    expect(
      resolveSlotPhaseWindow(
        {
          ...base,
          windowStart: "23:00",
          windowEnd: "01:00",
          timesOfDay: ["00:30"],
        },
        "00:30",
        null,
        slot,
        "UTC",
      ),
    ).toEqual({
      start: new Date("2026-07-28T23:00:00.000Z"),
      end: new Date("2026-07-29T01:00:00.000Z"),
    });
  });

  it("anchors a stale one-slot legacy duration at its first-class slot", () => {
    const slot = new Date("2026-07-28T20:00:00.000Z");
    expect(
      resolveSlotPhaseWindow(
        { ...base, timesOfDay: ["20:00"] },
        "20:00",
        null,
        slot,
        "UTC",
      ),
    ).toEqual({
      start: new Date("2026-07-28T20:00:00.000Z"),
      end: new Date("2026-07-28T21:00:00.000Z"),
    });
  });

  it("clamps spring-forward gap bounds instead of reversing the window", () => {
    const slot = new Date("2026-03-29T01:30:00.000Z"); // requested 02:30 -> 03:30
    const expected = {
      start: new Date("2026-03-29T01:30:00.000Z"),
      end: new Date("2026-03-29T01:30:00.000Z"),
    };

    const legacy = resolveSlotPhaseWindow(
      {
        ...base,
        windowStart: "02:30",
        windowEnd: "03:00",
        timesOfDay: ["02:30"],
      },
      "02:30",
      null,
      slot,
      "Europe/Berlin",
    );
    const explicit = resolveSlotPhaseWindow(
      { ...base, timesOfDay: ["02:30"] },
      "02:30",
      [{ timeOfDay: "02:30", start: "02:30", end: "03:00" }],
      slot,
      "Europe/Berlin",
    );

    expect(legacy).toEqual(expected);
    expect(explicit).toEqual(expected);
    expect(
      legacy.end.getTime() - legacy.start.getTime(),
    ).toBeGreaterThanOrEqual(0);
    expect(
      explicit.end.getTime() - explicit.start.getTime(),
    ).toBeGreaterThanOrEqual(0);
  });
});
