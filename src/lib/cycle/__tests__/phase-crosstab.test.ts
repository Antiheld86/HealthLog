import { describe, expect, it } from "vitest";

import {
  computePhaseMetricCrosstab,
  buildPhaseDiscoverySeries,
  discoverPhaseCorrelations,
  selectHeadlinePhaseRow,
  PHASE_ORDINAL,
  PHASE_CROSSTAB_METRIC_TYPES,
  PHASE_CROSSTAB_METRICS,
  CYCLE_PHASE_CHANNEL_KEY,
  MOOD_CHANNEL_KEY,
  type PhaseMetricCrosstabRow,
} from "../phase-crosstab";
import type { CrossMetricMeasurement } from "@/lib/insights/mood-aggregates";
import type { CyclePhase } from "../types";

/** Build a measurement row on a given YYYY-MM-DD at noon UTC. */
function m(type: string, day: string, value: number): CrossMetricMeasurement {
  return {
    type,
    value,
    measuredAt: new Date(`${day}T12:00:00.000Z`),
    source: "APPLE_HEALTH",
    deviceType: null,
  };
}

/**
 * A phase-day map + matching daily metric values, with the luteal group's
 * resting heart rate clearly higher than the follicular group's. Days run
 * 2026-03-01 onward; the first `n` are LUTEAL, the next `n` FOLLICULAR.
 */
function fixture(opts: {
  n: number;
  lutealRhr: number;
  follicularRhr: number;
}): {
  phaseByDay: Map<string, CyclePhase>;
  measurements: CrossMetricMeasurement[];
} {
  const phaseByDay = new Map<string, CyclePhase>();
  const measurements: CrossMetricMeasurement[] = [];
  let dayIdx = 0;
  const dayKey = (i: number) => {
    const d = new Date(Date.UTC(2026, 2, 1));
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  };
  for (let i = 0; i < opts.n; i++) {
    const k = dayKey(dayIdx++);
    phaseByDay.set(k, "LUTEAL");
    // tiny deterministic jitter so the group has non-zero variance
    measurements.push(
      m("RESTING_HEART_RATE", k, opts.lutealRhr + (i % 3) * 0.5),
    );
  }
  for (let i = 0; i < opts.n; i++) {
    const k = dayKey(dayIdx++);
    phaseByDay.set(k, "FOLLICULAR");
    measurements.push(
      m("RESTING_HEART_RATE", k, opts.follicularRhr + (i % 3) * 0.5),
    );
  }
  return { phaseByDay, measurements };
}

describe("PHASE_ORDINAL", () => {
  it("is the monotone menstrual→luteal progression", () => {
    expect(PHASE_ORDINAL.MENSTRUAL).toBe(0);
    expect(PHASE_ORDINAL.FOLLICULAR).toBe(1);
    expect(PHASE_ORDINAL.OVULATORY).toBe(2);
    expect(PHASE_ORDINAL.LUTEAL).toBe(3);
  });
});

describe("PHASE_CROSSTAB_METRIC_TYPES", () => {
  it("includes the temperature channels held out of the general matrix", () => {
    expect(PHASE_CROSSTAB_METRIC_TYPES).toContain("WRIST_TEMPERATURE");
    expect(PHASE_CROSSTAB_METRIC_TYPES).toContain("SKIN_TEMPERATURE");
    expect(PHASE_CROSSTAB_METRIC_TYPES).toContain("BODY_TEMPERATURE");
    expect(PHASE_CROSSTAB_METRIC_TYPES).toContain("RESTING_HEART_RATE");
  });

  it("includes GLUCOSE but NOT mood (mood is not a Measurement row)", () => {
    expect(PHASE_CROSSTAB_METRIC_TYPES).toContain("BLOOD_GLUCOSE");
    expect(PHASE_CROSSTAB_METRIC_TYPES).not.toContain(MOOD_CHANNEL_KEY);
  });

  it("declares mood + glucose as outcome metrics (QA HIGH)", () => {
    expect(PHASE_CROSSTAB_METRICS.mood.type).toBe(MOOD_CHANNEL_KEY);
    expect(PHASE_CROSSTAB_METRICS.bloodGlucose.type).toBe("BLOOD_GLUCOSE");
  });
});

describe("computePhaseMetricCrosstab — MOOD + GLUCOSE outcomes (QA HIGH)", () => {
  /** Build a luteal-vs-follicular contrast for an arbitrary outcome `type`. */
  function contrastFor(type: string, lutealVal: number, follicularVal: number) {
    const phaseByDay = new Map<string, CyclePhase>();
    const measurements: CrossMetricMeasurement[] = [];
    let idx = 0;
    const dayKey = (i: number) => {
      const d = new Date(Date.UTC(2026, 2, 1));
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    };
    for (let i = 0; i < 14; i++) {
      const k = dayKey(idx++);
      phaseByDay.set(k, "LUTEAL");
      measurements.push(m(type, k, lutealVal + (i % 3) * 0.5));
    }
    for (let i = 0; i < 14; i++) {
      const k = dayKey(idx++);
      phaseByDay.set(k, "FOLLICULAR");
      measurements.push(m(type, k, follicularVal + (i % 3) * 0.5));
    }
    return { phaseByDay, measurements };
  }

  it("surfaces a luteal-vs-follicular GLUCOSE contrast", () => {
    const { phaseByDay, measurements } = contrastFor("BLOOD_GLUCOSE", 105, 92);
    const rows = computePhaseMetricCrosstab({ phaseByDay, measurements });
    const glucose = rows.find((r) => r.metricKey === "bloodGlucose");
    expect(glucose).toBeDefined();
    expect(glucose!.display).toBe("glucose");
    expect(glucose!.delta).toBeGreaterThan(0);
    expect(glucose!.pValue).toBeLessThan(0.05);
  });

  it("surfaces a luteal-vs-follicular MOOD contrast (injected synthetic channel)", () => {
    const { phaseByDay, measurements } = contrastFor(
      MOOD_CHANNEL_KEY,
      4.4,
      2.6,
    );
    const rows = computePhaseMetricCrosstab({ phaseByDay, measurements });
    const mood = rows.find((r) => r.metricKey === "mood");
    expect(mood).toBeDefined();
    expect(mood!.display).toBe("mood");
    expect(mood!.delta).toBeGreaterThan(0);
    expect(mood!.pValue).toBeLessThan(0.05);
  });
});

describe("goalAllowsFertileWindow (QA MEDIUM)", () => {
  it("shows the fertile window for TRYING_TO_CONCEIVE and AVOID_PREGNANCY", async () => {
    const { goalAllowsFertileWindow } = await import("../dto");
    expect(goalAllowsFertileWindow("TRYING_TO_CONCEIVE")).toBe(true);
    expect(goalAllowsFertileWindow("AVOID_PREGNANCY")).toBe(true);
  });

  it("hides it for GENERAL_HEALTH / PERIMENOPAUSE / OFF", async () => {
    const { goalAllowsFertileWindow } = await import("../dto");
    expect(goalAllowsFertileWindow("GENERAL_HEALTH")).toBe(false);
    expect(goalAllowsFertileWindow("PERIMENOPAUSE")).toBe(false);
    expect(goalAllowsFertileWindow("OFF")).toBe(false);
  });
});

describe("computePhaseMetricCrosstab", () => {
  it("surfaces a clear luteal-vs-follicular RHR contrast", () => {
    const { phaseByDay, measurements } = fixture({
      n: 14,
      lutealRhr: 63,
      follicularRhr: 57,
    });
    const rows = computePhaseMetricCrosstab({ phaseByDay, measurements });
    const rhr = rows.find((r) => r.metricKey === "restingHeartRate");
    expect(rhr).toBeDefined();
    // luteal higher → positive delta (lutealAvg − follicularAvg)
    expect(rhr!.delta).toBeGreaterThan(0);
    expect(rhr!.lutealDays).toBe(14);
    expect(rhr!.follicularDays).toBe(14);
    expect(rhr!.pValue).toBeLessThan(0.05);
    expect(rhr!.qValue).toBeLessThanOrEqual(0.1);
    expect(["low", "medium", "high"]).toContain(rhr!.confidence);
  });

  it("returns no row when a phase group is below the day floor", () => {
    // 4 luteal days only — under CROSSTAB_MIN_PRESENT_DAYS (5).
    const { phaseByDay, measurements } = fixture({
      n: 4,
      lutealRhr: 63,
      follicularRhr: 57,
    });
    const rows = computePhaseMetricCrosstab({ phaseByDay, measurements });
    expect(rows).toEqual([]);
  });

  it("does not fabricate a row when the phases do not differ", () => {
    const { phaseByDay, measurements } = fixture({
      n: 20,
      lutealRhr: 60,
      follicularRhr: 60,
    });
    const rows = computePhaseMetricCrosstab({ phaseByDay, measurements });
    // No real separation → nothing clears p < 0.05.
    expect(
      rows.find((r) => r.metricKey === "restingHeartRate"),
    ).toBeUndefined();
  });

  it("ignores MENSTRUAL / OVULATORY days (only the two contrast phases count)", () => {
    const { phaseByDay, measurements } = fixture({
      n: 14,
      lutealRhr: 63,
      follicularRhr: 57,
    });
    // Add menstrual + ovulatory days with extreme values that would skew a
    // naive mean — they must be excluded from the contrast.
    const extra = new Date(Date.UTC(2026, 5, 1));
    for (let i = 0; i < 6; i++) {
      const k = new Date(extra);
      k.setUTCDate(k.getUTCDate() + i);
      const key = k.toISOString().slice(0, 10);
      phaseByDay.set(key, i % 2 === 0 ? "MENSTRUAL" : "OVULATORY");
      measurements.push(m("RESTING_HEART_RATE", key, 200));
    }
    const rows = computePhaseMetricCrosstab({ phaseByDay, measurements });
    const rhr = rows.find((r) => r.metricKey === "restingHeartRate")!;
    // Means reflect only the luteal/follicular days, not the 200-bpm noise.
    expect(rhr.lutealAvg).toBeLessThan(70);
    expect(rhr.follicularAvg).toBeLessThan(70);
  });

  it("returns empty for an empty phase map", () => {
    expect(
      computePhaseMetricCrosstab({
        phaseByDay: new Map(),
        measurements: [m("RESTING_HEART_RATE", "2026-03-01", 60)],
      }),
    ).toEqual([]);
  });
});

describe("buildPhaseDiscoverySeries", () => {
  it("emits a sorted ordinal CYCLE_PHASE behaviour series", () => {
    const phaseByDay = new Map<string, CyclePhase>([
      ["2026-03-03", "OVULATORY"],
      ["2026-03-01", "MENSTRUAL"],
      ["2026-03-02", "FOLLICULAR"],
      ["2026-03-04", "LUTEAL"],
    ]);
    const series = buildPhaseDiscoverySeries(phaseByDay);
    expect(series.key).toBe(CYCLE_PHASE_CHANNEL_KEY);
    expect(series.role).toBe("behaviour");
    expect(series.points.map((p) => p.day)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
    ]);
    expect(series.points.map((p) => p.value)).toEqual([0, 1, 2, 3]);
  });
});

describe("discoverPhaseCorrelations", () => {
  it("folds the continuous CYCLE_PHASE channel into the lagged-Pearson matrix", () => {
    // A contiguous 42-day span cycling MENSTRUAL→FOLLICULAR→OVULATORY→LUTEAL,
    // with next-day RHR tracking the phase ordinal so the lag-joined Pearson
    // is strong and clears n ≥ 20.
    const phaseByDay = new Map<string, CyclePhase>();
    const measurements: CrossMetricMeasurement[] = [];
    const phases: CyclePhase[] = [
      "MENSTRUAL",
      "FOLLICULAR",
      "OVULATORY",
      "LUTEAL",
    ];
    const base = new Date(Date.UTC(2026, 0, 1));
    for (let i = 0; i < 42; i++) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      const phase = phases[i % phases.length];
      phaseByDay.set(key, phase);
      // Next-day RHR = a clean linear function of THIS day's ordinal, so the
      // D→D+1 lag join recovers a near-perfect positive correlation.
      const nextKey = new Date(d);
      nextKey.setUTCDate(nextKey.getUTCDate() + 1);
      measurements.push(
        m(
          "RESTING_HEART_RATE",
          nextKey.toISOString().slice(0, 10),
          55 + PHASE_ORDINAL[phase] * 2,
        ),
      );
    }
    const result = discoverPhaseCorrelations({
      phaseByDay,
      measurements,
      locale: "en",
    });
    const pair = result.discovered.find(
      (p) => p.behaviour === CYCLE_PHASE_CHANNEL_KEY,
    );
    expect(pair).toBeDefined();
    expect(pair!.outcome).toBe("RESTING_HEART_RATE");
    expect(pair!.n).toBeGreaterThanOrEqual(20);
    expect(pair!.r).toBeGreaterThan(0.5);
    expect(pair!.qValue).toBeLessThanOrEqual(result.fdrQ);
    expect(pair!.interpretation).toMatch(/not a cause/);
  });

  it("returns no discovered pair on flat (non-correlated) data", () => {
    const phaseByDay = new Map<string, CyclePhase>();
    const measurements: CrossMetricMeasurement[] = [];
    const base = new Date(Date.UTC(2026, 0, 1));
    const phases: CyclePhase[] = [
      "MENSTRUAL",
      "FOLLICULAR",
      "OVULATORY",
      "LUTEAL",
    ];
    for (let i = 0; i < 42; i++) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      phaseByDay.set(key, phases[i % phases.length]);
      measurements.push(m("RESTING_HEART_RATE", key, 60)); // constant → no variance
    }
    const result = discoverPhaseCorrelations({
      phaseByDay,
      measurements,
      locale: "en",
    });
    expect(result.discovered).toEqual([]);
  });
});

describe("selectHeadlinePhaseRow", () => {
  const row = (metricKey: string): PhaseMetricCrosstabRow => ({
    metricKey: metricKey as PhaseMetricCrosstabRow["metricKey"],
    display: "bpm",
    lutealDays: 10,
    follicularDays: 10,
    lutealAvg: 63,
    follicularAvg: 57,
    delta: 6,
    pValue: 0.01,
    qValue: 0.02,
    confidence: "medium",
  });

  it("prefers resting heart rate", () => {
    const rows = [
      row("weight"),
      row("restingHeartRate"),
      row("heartRateVariability"),
    ];
    expect(selectHeadlinePhaseRow(rows)?.metricKey).toBe("restingHeartRate");
  });

  it("falls back to HRV when RHR is absent", () => {
    const rows = [row("weight"), row("heartRateVariability")];
    expect(selectHeadlinePhaseRow(rows)?.metricKey).toBe(
      "heartRateVariability",
    );
  });

  it("falls back to the strongest remaining row", () => {
    const rows = [row("weight")];
    expect(selectHeadlinePhaseRow(rows)?.metricKey).toBe("weight");
  });

  it("returns null on no rows", () => {
    expect(selectHeadlinePhaseRow([])).toBeNull();
  });
});
