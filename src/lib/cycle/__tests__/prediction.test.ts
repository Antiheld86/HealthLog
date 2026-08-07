import { describe, expect, it } from "vitest";

import { addDays } from "../day-math";
import { FERTILE_POST, FERTILE_PRE } from "../types";
import {
  clampLuteal,
  confirmSymptothermal,
  detectCervixPeak,
  detectLhSurgeOvulation,
  detectMucusPeak,
  detectTempShift,
  detectTemperatureTrend,
  estimateCycleLength,
  estimatePeriodLength,
  median,
  observedPeriodLength,
  predictCycle,
  resolveLuteal,
} from "../prediction";
import { toCyclePredictionDTO } from "../dto";
import type {
  CycleInput,
  CycleProfileInput,
  CyclePredictionResult,
  DayLogInput,
  NightlyTempInput,
} from "../types";

/**
 * These fixtures are the parity contract iOS reuses. Every expected date +
 * confidence is computed by hand from algorithm.md's pinned constants and
 * asserted exactly. The fixtures are constructed from a fixed seed date so the
 * assertions are timezone-independent (all day math is noon-UTC anchored).
 */

const BASE_PROFILE: CycleProfileInput = {
  goal: "TRYING_TO_CONCEIVE",
  typicalCycleLength: null,
  typicalPeriodLength: null,
  lutealPhaseLength: null,
  predictionEnabled: true,
  rawChartMode: false,
};

/** Build a chain of cycles from an anchor start, each `gap[i]` days apart. */
function cyclesFromGaps(anchor: string, gaps: number[]): CycleInput[] {
  const starts: string[] = [anchor];
  for (const g of gaps) starts.push(addDays(starts[starts.length - 1], g));
  return starts.map((startDate, i) => ({
    startDate,
    endDate: i < starts.length - 1 ? starts[i + 1] : null,
    periodEndDate: null,
    ovulationDate: null,
    ovulationConfirmed: false,
  }));
}

describe("cycle/prediction — robust statistics", () => {
  it("median: odd + even counts (even = mean of two central, unrounded)", () => {
    expect(median([28, 30, 29])).toBe(29);
    expect(median([28, 30])).toBe(29);
    expect(median([28, 31])).toBe(29.5);
    expect(median([])).toBeNaN();
  });
});

describe("cycle/prediction — cycle-length estimator (§1, §5)", () => {
  it("regular 28-day user: median 28, MAD 0 → sigma floor 1.0", () => {
    const est = estimateCycleLength(
      [28, 28, 28, 28, 28, 28],
      "TRYING_TO_CONCEIVE",
    );
    expect(est.lengthRounded).toBe(28);
    expect(est.sigma).toBe(1.0); // SIGMA_FLOOR (MAD = 0)
    expect(est.cyclesObserved).toBe(6);
    expect(est.cv).toBeCloseTo(1 / 28, 6);
  });

  it("irregular user: high MAD widens sigma", () => {
    // lengths 24,28,32,26,30,28 → median 28, deviations 4,0,4,2,2,0 → MAD 2
    const est = estimateCycleLength(
      [24, 28, 32, 26, 30, 28],
      "TRYING_TO_CONCEIVE",
    );
    expect(est.lengthRounded).toBe(28);
    expect(est.sigma).toBeCloseTo(1.4826 * 2, 6); // 2.9652
  });

  it("excludes a 3-MAD outlier from the point estimate but counts it against confidence", () => {
    // 28,28,29,28,28 + one wild 60-day (missed-log: >= 1.75*28 = 49).
    const est = estimateCycleLength(
      [28, 28, 29, 28, 28, 60],
      "TRYING_TO_CONCEIVE",
    );
    // 60 excluded → median over kept = 28, kept count = 5.
    expect(est.lengthRounded).toBe(28);
    expect(est.cyclesObserved).toBe(5);
  });

  it("hard-bounds: a 14-day length is always an outlier candidate", () => {
    const est = estimateCycleLength([28, 28, 14, 28, 29], "TRYING_TO_CONCEIVE");
    expect(est.cyclesObserved).toBe(4); // 14 excluded (< HARD_CYCLE_MIN 21)
    expect(est.lengthRounded).toBe(28);
  });

  it("keeps a legitimate long (oligomenorrhea) cycle inside the hard bound", () => {
    // A run of long-but-real cycles (ACOG: > 35 d is oligomenorrhea, still a
    // real cycle; perimenopause routinely runs longer). A 52-day length must
    // not be force-excluded by the hard ceiling — only the MAD fence / missed-
    // log heuristic should ever drop it. Here the whole run is long, so the
    // robust median sits near 50 and 52 is well inside the fence.
    const est = estimateCycleLength([48, 50, 52, 49, 51], "PERIMENOPAUSE");
    expect(est.cyclesObserved).toBe(5); // none clipped by HARD_CYCLE_MAX
    expect(est.lengthRounded).toBe(50);
  });

  it("perimenopause widens the fence (OUTLIER_K 4 keeps more)", () => {
    const lengths = [28, 30, 26, 40, 24, 32];
    const normal = estimateCycleLength(lengths, "TRYING_TO_CONCEIVE");
    const peri = estimateCycleLength(lengths, "PERIMENOPAUSE");
    expect(peri.cyclesObserved).toBeGreaterThanOrEqual(normal.cyclesObserved);
  });
});

describe("cycle/prediction — period-length estimator (§2)", () => {
  const cyc: CycleInput = {
    startDate: "2024-01-01",
    endDate: "2024-01-29",
    periodEndDate: null,
    ovulationDate: null,
    ovulationConfirmed: false,
  };

  function flowDay(date: string, flow: DayLogInput["flow"]): DayLogInput {
    return {
      date,
      flow,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: null,
    };
  }

  it("counts a contiguous 5-day bleeding run", () => {
    const logs = [
      flowDay("2024-01-01", "MEDIUM"),
      flowDay("2024-01-02", "HEAVY"),
      flowDay("2024-01-03", "MEDIUM"),
      flowDay("2024-01-04", "LIGHT"),
      flowDay("2024-01-05", "SPOTTING"),
    ];
    expect(observedPeriodLength("2024-01-01", logs)).toBe(5);
  });

  it("tolerates a single dry day inside the run but breaks on a 2-day gap", () => {
    const logs = [
      flowDay("2024-01-01", "MEDIUM"),
      flowDay("2024-01-02", "LIGHT"),
      // 01-03 dry (single gap, tolerated)
      flowDay("2024-01-04", "LIGHT"),
      // 01-05, 01-06 dry (2-day gap → break)
      flowDay("2024-01-07", "SPOTTING"),
    ];
    expect(observedPeriodLength("2024-01-01", logs)).toBe(4); // through 01-04
  });

  it("returns 0 when startDate itself has no bleeding", () => {
    expect(
      observedPeriodLength("2024-01-01", [flowDay("2024-01-02", "MEDIUM")]),
    ).toBe(0);
  });

  it("estimatePeriodLength prefers explicit periodEndDate", () => {
    const c = { ...cyc, periodEndDate: "2024-01-04" }; // 4-day period
    expect(estimatePeriodLength([c], [], BASE_PROFILE)).toBe(4);
  });

  it("falls back to population default (5) with no data and no prior", () => {
    expect(estimatePeriodLength([], [], BASE_PROFILE)).toBe(5);
  });
});

describe("cycle/prediction — predictCycle calendar path (§1–§3)", () => {
  it("regular 28-day user (≥6 cycles, no logs): exact band + medium confidence", () => {
    // 7 starts → 6 completed lengths of 28. Last start 2024-06-24.
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28, 28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate;
    // 7 starts = anchor + 6*28 = 2024-01-01 + 168 days.
    expect(lastStart).toBe("2024-06-17");

    const result = predictCycle(cycles, [], BASE_PROFILE, "2024-06-24");

    expect(result.method).toBe("CALENDAR");
    expect(result.cyclesObserved).toBe(6);
    expect(result.stillLearning).toBe(false);
    expect(result.estimatedCycleLength).toBe(28);
    expect(result.estimatedCycleSd).toBe(1.0);

    // nextStart = 2024-06-17 + 28 = 2024-07-15.
    expect(result.nextPeriodStart).toBe("2024-07-15");

    // halfWidth: density 0 (no logs) → logSparsity 0.5 → penalty 1.5.
    //   Z_BAND(1) * sigma(1) * 1.5 = 1.5 → round 2 → clamp [1,14] = 2.
    expect(result.nextPeriodStartLow).toBe("2024-07-13");
    expect(result.nextPeriodStartHigh).toBe("2024-07-17");

    // Ovulation = nextStart - luteal(14) = 2024-07-01.
    expect(result.predictedOvulation).toBe("2024-07-01");
    // Fertile window ov-5 … ov+1.
    expect(result.fertileWindowStart).toBe("2024-06-26");
    expect(result.fertileWindowEnd).toBe("2024-07-02");

    // confidence = cCount(1.0) * cVariance(1.0, cv≈0.036≤0.05) * cAdherence(0.4) = 0.40.
    expect(result.confidence).toBe(0.4);
    expect(result.confidenceLabel).toBe("medium");
  });

  it("irregular user: wider band, lower confidence", () => {
    // lengths 24,32,26,30,28,28 → median 28, MAD 2 → sigma 2.9652.
    const cycles = cyclesFromGaps("2024-01-01", [24, 32, 26, 30, 28, 28]);
    const result = predictCycle(cycles, [], BASE_PROFILE, "2024-07-10");

    expect(result.estimatedCycleLength).toBe(28);
    expect(result.estimatedCycleSd).toBeCloseTo(2.97, 2);
    // halfWidth = round(1 * 2.9652 * 1.5) = round(4.4478) = 4.
    const low = result.nextPeriodStartLow;
    const high = result.nextPeriodStartHigh;
    // band half-width is 4 days each side of nextStart.
    expect(low).toBe(addDays(result.nextPeriodStart, -4));
    expect(high).toBe(addDays(result.nextPeriodStart, 4));
    // cv = 2.9652/28 ≈ 0.1059 → cVariance 0.65; cCount 1.0; cAdherence 0.4.
    // confidence = 1.0 * 0.65 * 0.4 = 0.26 → low.
    expect(result.confidence).toBe(0.26);
    expect(result.confidenceLabel).toBe("low");
  });

  it("<2 cycles cold start (1 length): priors-flavoured, stillLearning, band bonus", () => {
    // 2 starts → 1 completed length of 30.
    const cycles = cyclesFromGaps("2024-01-01", [30]);
    const result = predictCycle(cycles, [], BASE_PROFILE, "2024-02-05");

    expect(result.cyclesObserved).toBe(1);
    expect(result.stillLearning).toBe(true);
    expect(result.estimatedCycleLength).toBe(30);
    // sigma falls back to SIGMA_FLOOR 1.0 (no MAD); +COLD_START_BAND_BONUS 3.
    // halfWidth = round(1*1*1.5)=2, +3 = 5 → clamp 5.
    expect(result.nextPeriodStartLow).toBe(addDays(result.nextPeriodStart, -5));
    expect(result.nextPeriodStartHigh).toBe(addDays(result.nextPeriodStart, 5));
    // cCount(1)=0.35, cVariance(cv=1/30≈0.033≤0.05)=1.0, cAdherence=0.4.
    // confidence = 0.35 * 1.0 * 0.4 = 0.14 → low.
    expect(result.confidence).toBe(0.14);
  });

  it("0 cycles priors-only: population default 28, confidence 0.20, fixed band 4", () => {
    const onlyStart: CycleInput[] = [
      {
        startDate: "2024-05-01",
        endDate: null,
        periodEndDate: null,
        ovulationDate: null,
        ovulationConfirmed: false,
      },
    ];
    const result = predictCycle(onlyStart, [], BASE_PROFILE, "2024-05-10");

    expect(result.method).toBe("CALENDAR");
    expect(result.cyclesObserved).toBe(0);
    expect(result.stillLearning).toBe(true);
    expect(result.estimatedCycleLength).toBe(28);
    expect(result.confidence).toBe(0.2);
    // nextStart = 2024-05-01 + 28 = 2024-05-29, fixed half-width 4.
    expect(result.nextPeriodStart).toBe("2024-05-29");
    expect(result.nextPeriodStartLow).toBe("2024-05-25");
    expect(result.nextPeriodStartHigh).toBe("2024-06-02");
  });

  it("respects a user-set typical-cycle prior on cold start", () => {
    const onlyStart: CycleInput[] = [
      {
        startDate: "2024-05-01",
        endDate: null,
        periodEndDate: null,
        ovulationDate: null,
        ovulationConfirmed: false,
      },
    ];
    const profile = { ...BASE_PROFILE, typicalCycleLength: 30 };
    const result = predictCycle(onlyStart, [], profile, "2024-05-10");
    expect(result.estimatedCycleLength).toBe(30);
    expect(result.nextPeriodStart).toBe("2024-05-31");
  });

  it("logging density lifts confidence and tightens the band", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28, 28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate; // 2024-06-24
    // Log every day since the last start through 'today' = full density.
    const logs: DayLogInput[] = [];
    for (let i = 0; i <= 7; i++) {
      logs.push({
        date: addDays(lastStart, i),
        flow: i < 4 ? "MEDIUM" : "NONE",
        basalBodyTempC: null,
        ovulationTest: null,
        cervicalMucus: null,
      });
    }
    const result = predictCycle(
      cycles,
      logs,
      BASE_PROFILE,
      addDays(lastStart, 7),
    );
    // density 1 → logSparsity 0 → penalty 1 → halfWidth round(1*1*1)=1.
    expect(result.nextPeriodStartLow).toBe(addDays(result.nextPeriodStart, -1));
    // cAdherence = 0.4 + 0.6*1 = 1.0 → confidence 1*1*1.0 = 0.98 (clamped from 1.0).
    expect(result.confidence).toBe(0.98);
    expect(result.confidenceLabel).toBe("high");
  });
});

describe("cycle/prediction — symptothermal confirmation (§4.2)", () => {
  function bbtDay(
    date: string,
    t: number,
    mucus: DayLogInput["cervicalMucus"] = null,
  ): DayLogInput {
    return {
      date,
      flow: null,
      basalBodyTempC: t,
      ovulationTest: null,
      cervicalMucus: mucus,
    };
  }

  function cervixDay(
    date: string,
    cervixPosition: DayLogInput["cervixPosition"],
    cervixFirmness: DayLogInput["cervixFirmness"],
    cervixOpening: DayLogInput["cervixOpening"],
  ): DayLogInput {
    return {
      date,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: null,
      cervixPosition,
      cervixFirmness,
      cervixOpening,
    };
  }

  it("detectTempShift: 3-over-6 with the 3rd reading >= 0.2°C over the 6-day max", () => {
    // 6 low baseline ~36.40, then 3 elevated clearing the max by 0.2.
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    const baseline = [36.4, 36.42, 36.38, 36.41, 36.4, 36.39]; // max 36.42
    baseline.forEach((t, i) => logs.push(bbtDay(addDays(start, i), t)));
    // rise: each > 36.42; 3rd (index 8) must be >= 36.62.
    logs.push(bbtDay(addDays(start, 6), 36.55));
    logs.push(bbtDay(addDays(start, 7), 36.6));
    logs.push(bbtDay(addDays(start, 8), 36.62));

    const shift = detectTempShift(logs, 0.2);
    expect(shift).not.toBeNull();
    // ovulation = day before the first elevated reading (offset 6 → 2024-01-07).
    expect(shift?.ovulationDate).toBe(addDays(start, 5));
  });

  it("detectTempShift: rejects a rise that does not clear the 0.2°C third-measurement bar", () => {
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    // 3rd reading only +0.1 over the 36.42 max.
    logs.push(bbtDay(addDays(start, 6), 36.45));
    logs.push(bbtDay(addDays(start, 7), 36.48));
    logs.push(bbtDay(addDays(start, 8), 36.52));
    expect(detectTempShift(logs, 0.2)).toBeNull();
  });

  it("detectTempShift rule 0: the regular rule reports rule:0 + evaluation on the 3rd day", () => {
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    logs.push(bbtDay(addDays(start, 6), 36.55));
    logs.push(bbtDay(addDays(start, 7), 36.6));
    logs.push(bbtDay(addDays(start, 8), 36.62)); // 3rd clears 0.2 over 36.42

    const shift = detectTempShift(logs, 0.2);
    expect(shift?.rule).toBe(0);
    expect(shift?.ovulationDate).toBe(addDays(start, 5));
    expect(shift?.evaluationCompleteDate).toBe(addDays(start, 8));
  });

  it("detectTempShift 1. Ausnahmeregel: slow/staircase rise confirms on the 4th reading", () => {
    // 1. Ausnahmeregel: 3rd high reading is above the line but NOT 0.2°C above;
    // a 4th reading above the line confirms (need only be above the line).
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    // cover line = 36.42. Staircase: all above the line, 3rd only +0.1.
    logs.push(bbtDay(addDays(start, 6), 36.45));
    logs.push(bbtDay(addDays(start, 7), 36.49));
    logs.push(bbtDay(addDays(start, 8), 36.52)); // +0.1 → regular rule fails
    // Without a 4th reading the strict + 1. rule cannot confirm.
    expect(detectTempShift([...logs], 0.2)).toBeNull();
    // 4th reading merely above the line (no 0.2 requirement) → confirmed by rule 1.
    logs.push(bbtDay(addDays(start, 9), 36.5));
    const shift = detectTempShift(logs, 0.2);
    expect(shift?.rule).toBe(1);
    expect(shift?.ovulationDate).toBe(addDays(start, 5));
    expect(shift?.evaluationCompleteDate).toBe(addDays(start, 9));
  });

  it("detectTempShift 2. Ausnahmeregel: a single fall-back day confirms on a 4th ≥0.2°C reading", () => {
    // 2. Ausnahmeregel: one of the 3 readings falls back to/below the line; it
    // is discounted and a 4th reading is required that again clears 0.2°C.
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    // cover line = 36.42. 1st + 2nd above, 3rd falls back below the line.
    logs.push(bbtDay(addDays(start, 6), 36.6));
    logs.push(bbtDay(addDays(start, 7), 36.62));
    logs.push(bbtDay(addDays(start, 8), 36.4)); // falls back below 36.42
    // Without a 4th reading nothing confirms.
    expect(detectTempShift([...logs], 0.2)).toBeNull();
    // 4th reading that does NOT clear 0.2 must not confirm.
    const tooLow = [...logs, bbtDay(addDays(start, 9), 36.5)]; // +0.08 only
    expect(detectTempShift(tooLow, 0.2)).toBeNull();
    // 4th reading ≥0.2°C above the line → confirmed by rule 2.
    logs.push(bbtDay(addDays(start, 9), 36.63)); // +0.21 over 36.42
    const shift = detectTempShift(logs, 0.2);
    expect(shift?.rule).toBe(2);
    expect(shift?.ovulationDate).toBe(addDays(start, 5));
    expect(shift?.evaluationCompleteDate).toBe(addDays(start, 9));
  });

  it("detectTempShift: an excluded (disturbed) baseline spike no longer masks a true rise", () => {
    const start = "2024-01-01";
    // 6 baseline days; the LAST (immediately before the rise) is a fever spike,
    // so it sits in the cover-line window. Unexcluded it raises the cover line
    // and contaminates detection; excluded it is dropped and the remaining lows
    // form the real (lower) cover line.
    const baseline = [36.4, 36.42, 36.38, 36.41, 36.4, 37.5];
    const extraLow = 36.39; // a 6th valid low so exclusion still leaves 6
    const rise = [36.55, 36.6, 36.62];
    const build = (excludeFever: boolean): DayLogInput[] => {
      const logs: DayLogInput[] = [];
      logs.push(bbtDay(addDays(start, 0), extraLow));
      baseline.forEach((t, i) => {
        const day = bbtDay(addDays(start, 1 + i), t);
        if (i === 5 && excludeFever) day.temperatureExcluded = true;
        logs.push(day);
      });
      rise.forEach((t, i) => logs.push(bbtDay(addDays(start, 7 + i), t)));
      return logs;
    };
    // Fever NOT excluded: the 37.5 spike contaminates detection — it does NOT
    // yield the correct shift (ovulation = day before the real rise).
    const corrupted = detectTempShift(build(false), 0.2);
    expect(corrupted?.ovulationDate).not.toBe(addDays(start, 6));
    // Fever excluded: cover line falls to the real baseline max and the genuine
    // rise confirms with ovulation the day before it (2024-01-07).
    const shift = detectTempShift(build(true), 0.2);
    expect(shift?.rule).toBe(0);
    expect(shift?.ovulationDate).toBe(addDays(start, 6));
  });

  it("detectTempShift: an excluded fever spike inside the rise no longer fabricates a shift", () => {
    const start = "2024-01-01";
    const logs: DayLogInput[] = [];
    [36.4, 36.4, 36.4, 36.4, 36.4, 36.4].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    const fever = bbtDay(addDays(start, 6), 38.0);
    fever.temperatureExcluded = true;
    logs.push(fever);
    logs.push(bbtDay(addDays(start, 7), 36.41));
    logs.push(bbtDay(addDays(start, 8), 36.4));
    // The excluded fever is dropped; the remaining readings show no rise.
    expect(detectTempShift(logs, 0.2)).toBeNull();
  });

  it("detectMucusPeak: confirms the last best-quality day followed by 3 drier days", () => {
    const m = (date: string, q: DayLogInput["cervicalMucus"]): DayLogInput => ({
      date,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: q,
    });
    const start = "2024-01-01";
    const logs = [
      m(addDays(start, 0), "STICKY"),
      m(addDays(start, 1), "CREAMY"),
      m(addDays(start, 2), "EGG_WHITE"), // peak candidate
      m(addDays(start, 3), "CREAMY"),
      m(addDays(start, 4), "STICKY"),
      m(addDays(start, 5), "DRY"),
    ];
    expect(detectMucusPeak(logs)).toBe(addDays(start, 2));
  });

  it("detectMucusPeak: returns null until 3 drier days follow the best-quality day", () => {
    const m = (date: string, q: DayLogInput["cervicalMucus"]): DayLogInput => ({
      date,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: q,
    });
    const start = "2024-01-01";
    // egg-white then only 2 drier observed days → not yet confirmable.
    const logs = [
      m(addDays(start, 0), "EGG_WHITE"),
      m(addDays(start, 1), "CREAMY"),
      m(addDays(start, 2), "DRY"),
    ];
    expect(detectMucusPeak(logs)).toBeNull();
  });

  it("detectMucusPeak: a stray late egg-white entry no longer moves a confirmed peak", () => {
    const m = (date: string, q: DayLogInput["cervicalMucus"]): DayLogInput => ({
      date,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: q,
    });
    const start = "2024-01-01";
    const logs = [
      m(addDays(start, 0), "EGG_WHITE"), // true peak
      m(addDays(start, 1), "CREAMY"),
      m(addDays(start, 2), "STICKY"),
      m(addDays(start, 3), "DRY"),
      // a stray late egg-white with NO 3 drier days after it (only 1 logged
      // day follows) — must not be confirmed as a new peak.
      m(addDays(start, 8), "EGG_WHITE"),
      m(addDays(start, 9), "DRY"),
    ];
    // The confirmed peak stays on the true (early) egg-white day, not the stray.
    expect(detectMucusPeak(logs)).toBe(addDays(start, 0));
  });

  it("confirmSymptothermal requires temp-shift and mucus-peak within ±2 days", () => {
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    logs.push(bbtDay(addDays(start, 6), 36.55));
    logs.push(bbtDay(addDays(start, 7), 36.6));
    logs.push(bbtDay(addDays(start, 8), 36.62));
    // temp ovulation = 2024-01-06. Add a mucus peak (EGG_WHITE) on 2024-01-06,
    // confirmed by 3 drier days after it (Sensiplan post-peak count).
    const mucusDay = (
      date: string,
      m: DayLogInput["cervicalMucus"],
    ): DayLogInput => ({
      date,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: m,
    });
    logs.push(mucusDay("2024-01-06", "EGG_WHITE"));
    logs.push(mucusDay("2024-01-07", "STICKY"));
    logs.push(mucusDay("2024-01-08", "DRY"));
    logs.push(mucusDay("2024-01-09", "DRY"));
    expect(confirmSymptothermal(logs)).toBe("2024-01-06");
  });

  it("confirmSymptothermal defaults to the mucus secondary symptom (cervix ignored)", () => {
    // A confirmed temp shift + a confirmed CERVIX peak but NO mucus must NOT
    // confirm on the default (mucus) path — the default behaviour is unchanged.
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    logs.push(bbtDay(addDays(start, 6), 36.55));
    logs.push(bbtDay(addDays(start, 7), 36.6));
    logs.push(bbtDay(addDays(start, 8), 36.62));
    // cervix peak on 2024-01-06, confirmed by 3 closed days — but no mucus.
    logs.push(cervixDay("2024-01-06", "HIGH", "SOFT", "OPEN"));
    logs.push(cervixDay("2024-01-07", "LOW", "FIRM", "CLOSED"));
    logs.push(cervixDay("2024-01-08", "LOW", "FIRM", "CLOSED"));
    logs.push(cervixDay("2024-01-09", "LOW", "FIRM", "CLOSED"));
    // Default secondary = mucus → no mucus peak → no confirmation.
    expect(confirmSymptothermal(logs)).toBeNull();
  });

  it("detectCervixPeak: confirms the last fertile-cervix day followed by 3 closed days", () => {
    const start = "2024-01-01";
    const logs = [
      cervixDay(addDays(start, 0), "LOW", "FIRM", "CLOSED"),
      cervixDay(addDays(start, 1), "HIGH", "SOFT", "OPEN"), // fertile peak
      cervixDay(addDays(start, 2), "LOW", "FIRM", "CLOSED"),
      cervixDay(addDays(start, 3), "LOW", "FIRM", "CLOSED"),
      cervixDay(addDays(start, 4), "LOW", "FIRM", "CLOSED"),
    ];
    expect(detectCervixPeak(logs)).toBe(addDays(start, 1));
  });

  it("detectCervixPeak: returns null until 3 closed days follow the fertile peak", () => {
    const start = "2024-01-01";
    const logs = [
      cervixDay(addDays(start, 0), "HIGH", "SOFT", "OPEN"),
      cervixDay(addDays(start, 1), "LOW", "FIRM", "CLOSED"),
      cervixDay(addDays(start, 2), "LOW", "FIRM", "CLOSED"),
    ];
    expect(detectCervixPeak(logs)).toBeNull();
  });

  it("confirmSymptothermal(CERVIX): a cervix peak + temp shift confirms like mucus does", () => {
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    logs.push(bbtDay(addDays(start, 6), 36.55));
    logs.push(bbtDay(addDays(start, 7), 36.6));
    logs.push(bbtDay(addDays(start, 8), 36.62));
    // temp ovulation = 2024-01-06. Cervix peak on 2024-01-06, confirmed by 3
    // closed days after it (cervix-closure rule).
    logs.push(cervixDay("2024-01-06", "HIGH", "SOFT", "OPEN"));
    logs.push(cervixDay("2024-01-07", "LOW", "FIRM", "CLOSED"));
    logs.push(cervixDay("2024-01-08", "LOW", "FIRM", "CLOSED"));
    logs.push(cervixDay("2024-01-09", "LOW", "FIRM", "CLOSED"));
    expect(confirmSymptothermal(logs, "CERVIX")).toBe("2024-01-06");
  });

  it("confirmSymptothermal(CERVIX): a cervix sign alone (no temp shift) never confirms", () => {
    const start = "2024-01-01";
    // A confirmed cervix peak but a FLAT temperature series (no rise).
    const logs: DayLogInput[] = [];
    [36.4, 36.41, 36.39, 36.4, 36.42, 36.4, 36.41, 36.4, 36.39].forEach(
      (t, i) => logs.push(bbtDay(addDays(start, i), t)),
    );
    logs.push(cervixDay(addDays(start, 4), "HIGH", "SOFT", "OPEN"));
    logs.push(cervixDay(addDays(start, 5), "LOW", "FIRM", "CLOSED"));
    logs.push(cervixDay(addDays(start, 6), "LOW", "FIRM", "CLOSED"));
    logs.push(cervixDay(addDays(start, 7), "LOW", "FIRM", "CLOSED"));
    // Single sign (cervix) without the temperature double-check → no confirmation.
    expect(confirmSymptothermal(logs, "CERVIX")).toBeNull();
  });

  it("predictCycle(CERVIX): a cervix-peak + temp shift confirms the same boundary as mucus", () => {
    const cervixProfile: CycleProfileInput = {
      ...BASE_PROFILE,
      secondarySymptom: "CERVIX",
    };
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate;
    const logs: DayLogInput[] = [];
    const ovDay = addDays(lastStart, 13);
    const riseStart = addDays(ovDay, 1);
    const baselineStart = addDays(riseStart, -6);
    [36.4, 36.41, 36.39, 36.4, 36.42, 36.4].forEach((t, i) =>
      logs.push(bbtDay(addDays(baselineStart, i), t)),
    );
    logs.push(bbtDay(riseStart, 36.6));
    logs.push(bbtDay(addDays(riseStart, 1), 36.62));
    logs.push(bbtDay(addDays(riseStart, 2), 36.63));
    // cervix peak agreeing with the temp ovulation, confirmed by 3 closed days.
    logs.push(cervixDay(ovDay, "HIGH", "SOFT", "OPEN"));
    logs.push(cervixDay(addDays(ovDay, 1), "LOW", "FIRM", "CLOSED"));
    logs.push(cervixDay(addDays(ovDay, 2), "LOW", "FIRM", "CLOSED"));
    logs.push(cervixDay(addDays(ovDay, 3), "LOW", "FIRM", "CLOSED"));

    const result = predictCycle(
      cycles,
      logs,
      cervixProfile,
      addDays(lastStart, 16),
    );
    expect(result.ovulationConfirmed).toBe(true);
    expect(result.method).toBe("BLENDED");
    expect(result.predictedOvulation).toBe(ovDay);
  });

  it("predictCycle: a confirmed symptothermal ovulation overrides next-start and tightens the band", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]); // 3 lengths, last start 2024-03-25
    const lastStart = cycles[cycles.length - 1].startDate;
    expect(lastStart).toBe("2024-03-25");

    // Build a temp shift in the current (in-progress) cycle with ovulation on lastStart+13.
    const logs: DayLogInput[] = [];
    const ovDay = addDays(lastStart, 13); // ovulation we want confirmed
    // 6 baseline ending the day before the rise; rise starts ovDay+1.
    const riseStart = addDays(ovDay, 1);
    const baselineStart = addDays(riseStart, -6);
    [36.4, 36.41, 36.39, 36.4, 36.42, 36.4].forEach((t, i) =>
      logs.push(bbtDay(addDays(baselineStart, i), t)),
    );
    logs.push(bbtDay(riseStart, 36.6));
    logs.push(bbtDay(addDays(riseStart, 1), 36.62));
    logs.push(bbtDay(addDays(riseStart, 2), 36.63));
    // mucus peak agreeing with the temp ovulation, confirmed by 3 drier days.
    const mucusDay = (
      date: string,
      m: DayLogInput["cervicalMucus"],
    ): DayLogInput => ({
      date,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: m,
    });
    logs.push(mucusDay(ovDay, "EGG_WHITE"));
    logs.push(mucusDay(addDays(ovDay, 1), "STICKY"));
    logs.push(mucusDay(addDays(ovDay, 2), "DRY"));
    logs.push(mucusDay(addDays(ovDay, 3), "DRY"));

    const result = predictCycle(
      cycles,
      logs,
      BASE_PROFILE,
      addDays(lastStart, 16),
    );
    expect(result.ovulationConfirmed).toBe(true);
    expect(result.method).toBe("BLENDED");
    expect(result.predictedOvulation).toBe(ovDay);
    // nextStart = confirmed ovulation + luteal(14).
    expect(result.nextPeriodStart).toBe(addDays(ovDay, 14));
  });
});

describe("cycle/prediction — Marquette LH/OPK ovulation anchor (§4, C2)", () => {
  function lhDay(date: string): DayLogInput {
    return {
      date,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: "POSITIVE_LH_SURGE",
      cervicalMucus: null,
    };
  }

  it("detectLhSurgeOvulation: anchors ovulation one day after the LAST positive LH", () => {
    const logs = [lhDay("2024-01-10"), lhDay("2024-01-11")];
    expect(detectLhSurgeOvulation(logs)).toBe("2024-01-12");
    expect(detectLhSurgeOvulation([])).toBeNull();
  });

  it("predictCycle: a positive LH surge anchors ovulation on the surge, not nextStart−luteal", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate; // 2024-03-25
    // The calendar back-calc would place ovulation at nextStart−14. A positive
    // LH on lastStart+16 should anchor ovulation to lastStart+17.
    const lhDate = addDays(lastStart, 16);
    const logs = [lhDay(lhDate)];
    const today = addDays(lastStart, 18);

    const calendarOnly = predictCycle(cycles, [], BASE_PROFILE, today);
    const withLh = predictCycle(cycles, logs, BASE_PROFILE, today);

    // The LH anchor moves the ovulation estimate off the calendar back-calc.
    expect(withLh.predictedOvulation).toBe(addDays(lhDate, 1));
    expect(withLh.predictedOvulation).not.toBe(calendarOnly.predictedOvulation);
    // next-start = anchored ovulation + luteal(14).
    expect(withLh.nextPeriodStart).toBe(addDays(lhDate, 1 + 14));
    expect(withLh.method).toBe("BLENDED");
    // A single LH indicator never asserts CONFIRMED ovulation.
    expect(withLh.ovulationConfirmed).toBe(false);
  });

  it("predictCycle: LH sharpens the estimate in the thin-data (1-cycle) case", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28]); // one completed length
    const lastStart = cycles[cycles.length - 1].startDate; // 2024-01-29
    const lhDate = addDays(lastStart, 15);
    const today = addDays(lastStart, 17);
    const result = predictCycle(cycles, [lhDay(lhDate)], BASE_PROFILE, today);
    expect(result.predictedOvulation).toBe(addDays(lhDate, 1));
    expect(result.ovulationConfirmed).toBe(false);
    // The still-learning gate is preserved (1 cycle < 3).
    expect(result.stillLearning).toBe(true);
  });

  it("predictCycle: a confirmed symptothermal ovulation wins over the LH anchor", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate;
    const ovDay = addDays(lastStart, 13);
    const riseStart = addDays(ovDay, 1);
    const baselineStart = addDays(riseStart, -6);
    const logs: DayLogInput[] = [];
    [36.4, 36.41, 36.39, 36.4, 36.42, 36.4].forEach((t, i) =>
      logs.push({
        date: addDays(baselineStart, i),
        flow: null,
        basalBodyTempC: t,
        ovulationTest: null,
        cervicalMucus: null,
      }),
    );
    const bbt = (date: string, t: number): DayLogInput => ({
      date,
      flow: null,
      basalBodyTempC: t,
      ovulationTest: null,
      cervicalMucus: null,
    });
    logs.push(bbt(riseStart, 36.6));
    logs.push(bbt(addDays(riseStart, 1), 36.62));
    logs.push(bbt(addDays(riseStart, 2), 36.63));
    const mucus = (
      date: string,
      m: DayLogInput["cervicalMucus"],
    ): DayLogInput => ({
      date,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: m,
    });
    logs.push(mucus(ovDay, "EGG_WHITE"));
    logs.push(mucus(addDays(ovDay, 1), "STICKY"));
    logs.push(mucus(addDays(ovDay, 2), "DRY"));
    logs.push(mucus(addDays(ovDay, 3), "DRY"));
    // A contradicting LH surge far from the temp shift must NOT override it.
    logs.push(lhDay(addDays(ovDay, 5)));

    const result = predictCycle(
      cycles,
      logs,
      BASE_PROFILE,
      addDays(lastStart, 20),
    );
    expect(result.ovulationConfirmed).toBe(true);
    expect(result.predictedOvulation).toBe(ovDay); // symptothermal wins
  });
});

describe("cycle/prediction — temperature-trend retrospective ovulation (§4.3)", () => {
  it("detectTemperatureTrend: 3-of-4 nights >= +0.15°C over the trailing 6-night mean", () => {
    const start = "2024-02-01";
    const nights: NightlyTempInput[] = [];
    // 6 trailing nights at 36.30 → mean 36.30.
    for (let i = 0; i < 6; i++)
      nights.push({ date: addDays(start, i), valueC: 36.3 });
    // 4-night window: 3 elevated (>= 36.45) + 1 not.
    nights.push({ date: addDays(start, 6), valueC: 36.46 });
    nights.push({ date: addDays(start, 7), valueC: 36.47 });
    nights.push({ date: addDays(start, 8), valueC: 36.3 });
    nights.push({ date: addDays(start, 9), valueC: 36.48 });

    const ov = detectTemperatureTrend(nights);
    // rise onset = first window night (offset 6 → 2024-02-07); ovulation = night before.
    expect(ov).toBe(addDays(start, 5));
  });

  it("predictCycle uses temperature-trend when no manual symptothermal confirmation exists", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate;
    const start = addDays(lastStart, 5);
    const nights: NightlyTempInput[] = [];
    for (let i = 0; i < 6; i++)
      nights.push({ date: addDays(start, i), valueC: 36.3 });
    nights.push({ date: addDays(start, 6), valueC: 36.46 });
    nights.push({ date: addDays(start, 7), valueC: 36.47 });
    nights.push({ date: addDays(start, 8), valueC: 36.48 });
    nights.push({ date: addDays(start, 9), valueC: 36.49 });

    const result = predictCycle(
      cycles,
      [],
      BASE_PROFILE,
      addDays(lastStart, 20),
      nights,
    );
    expect(result.ovulationConfirmed).toBe(true);
    expect(result.method).toBe("BLENDED");
    expect(result.predictedOvulation).toBe(addDays(start, 5));
  });
});

describe("cycle/prediction — multi-cycle window scoping (QA HIGH)", () => {
  function bbtDay(
    date: string,
    t: number,
    mucus: DayLogInput["cervicalMucus"] = null,
  ): DayLogInput {
    return {
      date,
      flow: null,
      basalBodyTempC: t,
      ovulationTest: null,
      cervicalMucus: mucus,
    };
  }

  /** Build a confirmable symptothermal shift (temp + agreeing mucus) on `ovDay`. */
  function symptothermalAround(ovDay: string): DayLogInput[] {
    const logs: DayLogInput[] = [];
    const riseStart = addDays(ovDay, 1);
    const baselineStart = addDays(riseStart, -6);
    [36.4, 36.41, 36.39, 36.4, 36.42, 36.4].forEach((t, i) =>
      logs.push(bbtDay(addDays(baselineStart, i), t)),
    );
    logs.push(bbtDay(riseStart, 36.6));
    logs.push(bbtDay(addDays(riseStart, 1), 36.62));
    logs.push(bbtDay(addDays(riseStart, 2), 36.63));
    const mucusDay = (
      date: string,
      m: DayLogInput["cervicalMucus"],
    ): DayLogInput => ({
      date,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: m,
    });
    // Peak on ovDay confirmed by 3 drier observed days (Sensiplan post-peak count).
    logs.push(mucusDay(ovDay, "EGG_WHITE"));
    logs.push(mucusDay(addDays(ovDay, 1), "STICKY"));
    logs.push(mucusDay(addDays(ovDay, 2), "DRY"));
    logs.push(mucusDay(addDays(ovDay, 3), "DRY"));
    return logs;
  }

  it("does not confirm a STALE prior-cycle ovulation for a multi-cycle user", () => {
    // Three confirmed cycles; last start 2024-03-25, today well into the
    // current cycle. The ONLY BBT/mucus data is a complete shift back in the
    // FIRST cycle (months ago). Pre-fix, detectTempShift returned that stale
    // shift and nextPeriodStart landed in the past.
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate;
    expect(lastStart).toBe("2024-03-25");

    const staleOv = addDays("2024-01-01", 13); // 2024-01-14, two cycles back
    const logs = symptothermalAround(staleOv);

    const today = addDays(lastStart, 16);
    const result = predictCycle(cycles, logs, BASE_PROFILE, today);

    // Stale signal is outside [lastStart − BBT_WINDOW, today] → ignored.
    expect(result.ovulationConfirmed).toBe(false);
    expect(result.method).toBe("CALENDAR");
    // Calendar next-start is in the future, never in the past.
    expect(result.nextPeriodStart >= today).toBe(true);
  });

  it("confirms the CURRENT-cycle shift even when a prior-cycle shift also exists", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate; // 2024-03-25

    const staleOv = addDays("2024-01-01", 13); // months ago
    const currentOv = addDays(lastStart, 13); // current cycle
    const logs = [
      ...symptothermalAround(staleOv),
      ...symptothermalAround(currentOv),
    ];

    const result = predictCycle(
      cycles,
      logs,
      BASE_PROFILE,
      addDays(lastStart, 16),
    );
    expect(result.ovulationConfirmed).toBe(true);
    expect(result.predictedOvulation).toBe(currentOv);
    expect(result.nextPeriodStart).toBe(addDays(currentOv, 14));
  });

  it("detectTempShift returns the LATEST qualifying shift, not the earliest", () => {
    const logs: DayLogInput[] = [];
    // First shift around 2024-01-07.
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    logs.push(bbtDay(addDays(start, 6), 36.6));
    logs.push(bbtDay(addDays(start, 7), 36.61));
    logs.push(bbtDay(addDays(start, 8), 36.62));
    // Drop back to baseline, then a SECOND shift a month later.
    const start2 = "2024-02-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start2, i), t)),
    );
    logs.push(bbtDay(addDays(start2, 6), 36.6));
    logs.push(bbtDay(addDays(start2, 7), 36.61));
    logs.push(bbtDay(addDays(start2, 8), 36.62));

    const shift = detectTempShift(logs, 0.2);
    // Latest match → day before the second rise onset (2024-02-07 → 2024-02-06).
    expect(shift?.ovulationDate).toBe(addDays(start2, 5));
  });
});

describe("cycle/prediction — luteal clamp single source of truth (QA HIGH)", () => {
  it("clampLuteal pins a raw value to [10, 16]", () => {
    expect(clampLuteal(8)).toBe(10);
    expect(clampLuteal(20)).toBe(16);
    expect(clampLuteal(13)).toBe(13);
  });

  it("resolveLuteal applies the default then the clamp", () => {
    expect(resolveLuteal({ lutealPhaseLength: null })).toBe(14);
    expect(resolveLuteal({ lutealPhaseLength: 8 })).toBe(10);
    expect(resolveLuteal({ lutealPhaseLength: 19 })).toBe(16);
  });

  it("predictCycle ovulation uses the CLAMPED luteal for an out-of-clamp profile", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate;
    // Profile asks for luteal 8 → engine clamps to 10.
    const profile: CycleProfileInput = {
      ...BASE_PROFILE,
      lutealPhaseLength: 8,
    };
    const result = predictCycle(cycles, [], profile, addDays(lastStart, 5));
    // predictedOvulation = nextStart − clampedLuteal(10).
    expect(result.predictedOvulation).toBe(
      addDays(result.nextPeriodStart, -10),
    );
  });
});

describe("cycle/dto — toCyclePredictionDTO still-learning honesty gate (M-1)", () => {
  /** A fully-populated engine result; `stillLearning` is overridden per case. */
  function makeResult(
    overrides: Partial<CyclePredictionResult> = {},
  ): CyclePredictionResult {
    return {
      method: "CALENDAR",
      nextPeriodStart: "2024-02-01",
      nextPeriodStartLow: "2024-01-30",
      nextPeriodStartHigh: "2024-02-03",
      predictedPeriodLength: 5,
      fertileWindowStart: "2024-01-14",
      fertileWindowEnd: "2024-01-20",
      predictedOvulation: "2024-01-18",
      ovulationConfirmed: true,
      confidence: 0.6,
      confidenceLabel: "medium",
      cyclesObserved: 5,
      stillLearning: false,
      estimatedCycleLength: 28,
      estimatedCycleSd: 1.5,
      ...overrides,
    };
  }

  it("suppresses the fertile window + predicted ovulation on the wire while still learning (<3 cycles), even when the goal allows it", () => {
    const result = makeResult({ stillLearning: true, cyclesObserved: 2 });
    const dto = toCyclePredictionDTO(result, /* goalAllowsFertile */ true, "d");

    expect(dto.fertileWindowStart).toBeNull();
    expect(dto.fertileWindowEnd).toBeNull();
    expect(dto.predictedOvulation).toBeNull();
    // The honesty flag still reaches the client so it can paint the calm state.
    expect(dto.stillLearning).toBe(true);
  });

  it("populates the fertile window + predicted ovulation once learning completes (>=3 cycles) and the goal allows it", () => {
    const result = makeResult({ stillLearning: false, cyclesObserved: 3 });
    const dto = toCyclePredictionDTO(result, /* goalAllowsFertile */ true, "d");

    expect(dto.fertileWindowStart).toBe("2024-01-14");
    expect(dto.fertileWindowEnd).toBe("2024-01-20");
    expect(dto.predictedOvulation).toBe("2024-01-18");
    expect(dto.stillLearning).toBe(false);
  });

  it("keeps ovulationConfirmed goal-gated only — unchanged by the still-learning gate", () => {
    // Still learning but goal allows: a confirmed shift is observed data, not a
    // prior, so it stays surfaced even while the predicted window is suppressed.
    const learning = toCyclePredictionDTO(
      makeResult({ stillLearning: true, ovulationConfirmed: true }),
      true,
      "d",
    );
    expect(learning.ovulationConfirmed).toBe(true);

    // Goal forbids the fertile window → confirmation drops regardless of learning.
    const goalGated = toCyclePredictionDTO(
      makeResult({ stillLearning: false, ovulationConfirmed: true }),
      false,
      "d",
    );
    expect(goalGated.ovulationConfirmed).toBe(false);
    expect(goalGated.fertileWindowStart).toBeNull();
    expect(goalGated.predictedOvulation).toBeNull();
  });
});

describe("cycle/prediction — the fertile window's width (A10)", () => {
  it("spans seven days, ending the day after the ovulation estimate", () => {
    // The comment on the constants used to say six days and the constants made
    // seven. The width is now a decision with a reason written at the constant,
    // so it is pinned here rather than left to be re-read off the same numbers
    // the code uses: five days before the estimate, the estimate, and one after.
    const cycles = cyclesFromGaps("2026-01-01", [28, 28, 28]);
    const p = predictCycle(cycles, [], BASE_PROFILE, "2026-03-20", []);

    expect(p.predictedOvulation).not.toBeNull();
    expect(p.fertileWindowStart).toBe(addDays(p.predictedOvulation!, -5));
    expect(p.fertileWindowEnd).toBe(addDays(p.predictedOvulation!, 1));

    const span =
      (Date.parse(`${p.fertileWindowEnd}T12:00:00Z`) -
        Date.parse(`${p.fertileWindowStart}T12:00:00Z`)) /
      86_400_000;
    // Inclusive of both ends.
    expect(span + 1).toBe(7);
  });

  it("keeps the extra day on the side that costs least to be wrong about", () => {
    // The trailing day is estimator slack plus ovum viability. Dropping it
    // would shorten the window for somebody avoiding pregnancy, which is the
    // direction that misses.
    expect(FERTILE_PRE).toBe(5);
    expect(FERTILE_POST).toBe(1);
  });
});
