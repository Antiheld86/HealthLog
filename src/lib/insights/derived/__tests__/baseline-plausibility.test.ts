/**
 * A stored value the application declares impossible is not a measurement.
 *
 * The personal band ("your usual range") and the deviation line that reads
 * against it are both means over stored `Measurement.value`. Neither end
 * checked the value against the metric's own plausibility domain, so a single
 * impossible pulse reading — the shape a provider unit-decode slip or a writer
 * without the range gate produces — moved the day mean, the median carried it
 * into the band, and the card said "your pulse is above your usual range,
 * currently 111,287,531.01 instead of the usual 36,016.75".
 *
 * The numbers below are shaped like the real thing: a resting-pulse series in
 * the 60s and 70s, one impossible sample dropped into it.
 */
import { describe, expect, it } from "vitest";

import { buildBaselineBand, dayMeansFromRows } from "../baseline";
import { latestDayMeanFromRows } from "../coincident-deviation";
import { isPlausibleMetricValue } from "@/lib/measurements/value-domain";

const TZ = "Europe/Berlin";

/** A real-shaped resting-pulse day: four readings in the 60s/70s. */
function pulseDay(day: string, values: number[]) {
  return values.map((value, i) => ({
    value,
    measuredAt: new Date(`${day}T0${6 + i}:30:00.000Z`),
  }));
}

describe("metric plausibility domain", () => {
  it("admits a real pulse and refuses one no heart produces", () => {
    expect(isPlausibleMetricValue("PULSE", 68)).toBe(true);
    expect(isPlausibleMetricValue("PULSE", 20)).toBe(true);
    expect(isPlausibleMetricValue("PULSE", 300)).toBe(true);
    expect(isPlausibleMetricValue("PULSE", 111287531.01)).toBe(false);
    expect(isPlausibleMetricValue("PULSE", 36016.75)).toBe(false);
    expect(isPlausibleMetricValue("PULSE", 19)).toBe(false);
  });

  it("passes a metric with no declared range and refuses a non-finite value", () => {
    expect(isPlausibleMetricValue("SOMETHING_UNDECLARED", 12345)).toBe(true);
    expect(isPlausibleMetricValue("PULSE", Number.NaN)).toBe(false);
    expect(isPlausibleMetricValue("PULSE", Number.POSITIVE_INFINITY)).toBe(
      false,
    );
  });
});

describe("per-day means behind the personal band", () => {
  it("keeps the day mean on the real readings when one sample is impossible", () => {
    const rows = pulseDay("2026-08-01", [66, 70, 111287531.01, 68]);

    const [point] = dayMeansFromRows(rows, "PULSE");

    expect(point.day).toBe("2026-08-01");
    expect(point.mean).toBeCloseTo(68, 6);
  });

  it("drops a day whose every reading is impossible rather than inventing one", () => {
    const rows = [
      ...pulseDay("2026-08-01", [66, 70, 68]),
      ...pulseDay("2026-08-02", [36016.75, 111287531.01]),
    ];

    const points = dayMeansFromRows(rows, "PULSE");

    expect(points.map((p) => p.day)).toEqual(["2026-08-01"]);
  });

  it("holds the band inside the metric's own domain across a poisoned month", () => {
    const rows: { value: number; measuredAt: Date }[] = [];
    for (let d = 1; d <= 28; d += 1) {
      const day = `2026-08-${String(d).padStart(2, "0")}`;
      // A steady resting pulse with a normal day-to-day wobble.
      rows.push(...pulseDay(day, [64 + (d % 5), 70 + (d % 3), 67]));
    }
    // Three days the provider decoded wrong.
    rows.push(...pulseDay("2026-08-05", [36016.75]));
    rows.push(...pulseDay("2026-08-17", [111287531.01]));
    rows.push(...pulseDay("2026-08-26", [98211.5]));

    const band = buildBaselineBand(
      dayMeansFromRows(rows, "PULSE").map((p) => p.mean),
      "PULSE",
    );

    expect(band).not.toBeNull();
    expect(band!.center).toBeGreaterThan(40);
    expect(band!.center).toBeLessThan(120);
    expect(band!.low).toBeGreaterThan(20);
    expect(band!.high).toBeLessThan(300);
  });
});

describe("the latest-day mean the deviation line reads", () => {
  it("means only the real readings of the most recent day", () => {
    const rows = [
      ...pulseDay("2026-08-01", [66, 70, 68]),
      ...pulseDay("2026-08-02", [72, 111287531.01, 74]),
    ];

    const latest = latestDayMeanFromRows(rows, "PULSE", TZ);

    expect(latest).not.toBeNull();
    expect(latest!.day).toBe("2026-08-02");
    expect(latest!.value).toBeCloseTo(73, 6);
  });

  it("reports nothing when the latest day holds no plausible reading", () => {
    const rows = pulseDay("2026-08-02", [36016.75, 111287531.01]);

    expect(latestDayMeanFromRows(rows, "PULSE", TZ)).toBeNull();
  });
});
