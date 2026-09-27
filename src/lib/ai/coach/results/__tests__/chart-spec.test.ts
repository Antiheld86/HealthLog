/**
 * The chart a result table gets. Pure and deterministic: every rule of the
 * heuristic, and every way a table ends up with no chart.
 */
import { describe, expect, it } from "vitest";

import type {
  CoachResultCell,
  CoachResultColumn,
  CoachResultTable,
  CoachStepDomain,
} from "@/lib/ai/coach/types";

import {
  CATEGORY_TOP_N,
  HISTOGRAM_MAX_BINS,
  HISTOGRAM_MIN_BINS,
  METRIC_AGGREGATION_KIND,
  buildDistributionTable,
  buildHistogram,
  chartCategoryRows,
  deriveChartSpec,
  type DistributionLabels,
} from "../chart-spec";

const DAY: CoachResultColumn = {
  key: "day",
  kind: "period",
  labelKey: "coach.result.column.day",
  label: "Day",
};
const READINGS: CoachResultColumn = {
  key: "readings",
  kind: "count",
  labelKey: "coach.result.column.readings",
  label: "Readings",
};

function valueColumn(
  key: string,
  unit?: string,
  kind: "number" | "count" = "number",
): CoachResultColumn {
  return {
    key,
    kind,
    labelKey: `coach.result.column.${key}`,
    label: key,
    ...(unit ? { unit } : {}),
    decimals: 0,
  };
}

function dayKey(index: number): string {
  const date = new Date(Date.UTC(2026, 0, 1 + index));
  return date.toISOString().slice(0, 10);
}

function timeSeries(args: {
  domain: CoachStepDomain;
  columns: CoachResultColumn[];
  rows: CoachResultCell[][];
  granularity?: "day" | "week" | "month";
}): CoachResultTable {
  return {
    ref: "r1",
    source: {
      tool: "get_metric_table",
      domain: args.domain,
      window: "last90days",
      period: "current",
      granularity: args.granularity ?? "day",
    },
    shape: "timeSeries",
    titleKey: "coach.result.title.byDay",
    title: "By day",
    rowCount: args.rows.length,
    chartKind: null,
    displayed: true,
    columns: args.columns,
    rows: args.rows,
    truncated: false,
    chart: null,
  };
}

function daySeries(
  domain: CoachStepDomain,
  values: Array<number | null>,
  unit?: string,
): CoachResultTable {
  return timeSeries({
    domain,
    columns: [DAY, valueColumn("value", unit), READINGS],
    rows: values.map((value, index) => [
      dayKey(index),
      value,
      value === null ? null : 1,
    ]),
  });
}

function categories(
  counts: Array<number | null>,
  names?: string[],
): CoachResultTable {
  return {
    ref: "r2",
    source: {
      tool: "get_workouts",
      domain: "workouts",
      window: "last30days",
      period: "current",
    },
    shape: "categoryCounts",
    titleKey: "coach.result.title.workoutsBySport",
    title: "Workouts by sport",
    rowCount: counts.length,
    chartKind: null,
    displayed: true,
    columns: [
      {
        key: "sport",
        kind: "category",
        labelKey: "coach.result.column.sport",
        label: "Sport",
      },
      valueColumn("sessions", undefined, "count"),
      valueColumn("duration", "min"),
    ],
    rows: counts.map((count, index) => [
      names?.[index] ?? `sport-${index + 1}`,
      count,
      count === null ? null : count * 30,
    ]),
    truncated: false,
    chart: null,
  };
}

const LABELS: DistributionLabels = {
  localeTag: "en-US",
  title: "Pulse: how often each range came up",
  range: "Range",
  count: "Times",
  bin: (from, to, unit) => `${from}–${to} ${unit}`,
};

describe("deriveChartSpec: the row floor and ceiling", () => {
  it("draws nothing for a single row", () => {
    expect(deriveChartSpec(daySeries("pulse", [62]))).toBeNull();
  });

  it("draws nothing for 401 rows", () => {
    const values = Array.from({ length: 401 }, (_, i) => 60 + (i % 10));
    expect(deriveChartSpec(daySeries("pulse", values))).toBeNull();
  });

  it("draws 400 rows", () => {
    const values = Array.from({ length: 400 }, (_, i) => 60 + (i % 10));
    expect(deriveChartSpec(daySeries("pulse", values))?.kind).toBe("line");
  });

  it("draws nothing when no column is numeric", () => {
    const table = timeSeries({
      domain: "pulse",
      columns: [DAY, { ...valueColumn("note"), kind: "category" }],
      rows: [
        [dayKey(0), "a"],
        [dayKey(1), "b"],
      ],
    });
    expect(deriveChartSpec(table)).toBeNull();
  });

  it("draws nothing when every period is empty", () => {
    expect(deriveChartSpec(daySeries("pulse", [null, null, null]))).toBeNull();
  });

  it("draws nothing for a time series without a period column", () => {
    const table = timeSeries({
      domain: "pulse",
      columns: [valueColumn("value", "bpm")],
      rows: [[60], [61]],
    });
    expect(deriveChartSpec(table)).toBeNull();
  });
});

describe("deriveChartSpec: time series", () => {
  it("draws a level metric as a line over the period column", () => {
    expect(
      deriveChartSpec(daySeries("weight", [80, 80.4, 79.9], "kg")),
    ).toEqual({ kind: "line", x: "day", series: ["value"] });
  });

  it("draws a total as vertical bars", () => {
    expect(
      deriveChartSpec(daySeries("steps", [8000, 12000, 5400], "steps")),
    ).toEqual({
      kind: "bar",
      x: "day",
      series: ["value"],
      orientation: "vertical",
    });
  });

  it("draws blood pressure as two series in one unit", () => {
    const table = timeSeries({
      domain: "bp",
      columns: [
        DAY,
        valueColumn("systolic", "mmHg"),
        valueColumn("diastolic", "mmHg"),
        READINGS,
      ],
      rows: [
        [dayKey(0), 128, 82, 2],
        [dayKey(1), 124, 80, 1],
      ],
    });
    expect(deriveChartSpec(table)).toEqual({
      kind: "line",
      x: "day",
      series: ["systolic", "diastolic"],
    });
  });

  it("keeps mixed units off one chart: the first series alone", () => {
    const table = timeSeries({
      domain: "weight",
      columns: [
        DAY,
        valueColumn("value", "kg"),
        valueColumn("fat", "%"),
        READINGS,
      ],
      rows: [
        [dayKey(0), 80, 22],
        [dayKey(1), 79.5, 21.8],
      ],
    });
    expect(deriveChartSpec(table)).toEqual({
      kind: "line",
      x: "day",
      series: ["value"],
    });
  });

  it("draws at most two series, the first compatible pair", () => {
    const table = timeSeries({
      domain: "pulse",
      columns: [
        DAY,
        valueColumn("sdnn", "ms"),
        valueColumn("other", "%"),
        valueColumn("rmssd", "ms"),
        valueColumn("third", "ms"),
      ],
      rows: [
        [dayKey(0), 40, 1, 30, 20],
        [dayKey(1), 42, 2, 31, 21],
      ],
    });
    expect(deriveChartSpec(table)).toEqual({
      kind: "line",
      x: "day",
      series: ["sdnn", "rmssd"],
    });
  });

  it("draws one HRV estimator, not SDNN and RMSSD as a pair", () => {
    // The two columns are alternative estimators of one quantity; drawn
    // together they read as a comparison they are not.
    const table = timeSeries({
      domain: "hrv",
      columns: [DAY, valueColumn("rmssd", "ms"), valueColumn("sdnn", "ms")],
      rows: [
        [dayKey(0), 40, 55],
        [dayKey(1), 42, 57],
      ],
    });
    expect(deriveChartSpec(table)).toEqual({
      kind: "line",
      x: "day",
      series: ["rmssd"],
    });
  });

  it("leaves the reading count off the chart", () => {
    const spec = deriveChartSpec(daySeries("pulse", [60, 62], "bpm"));
    expect(spec && "series" in spec ? spec.series : []).not.toContain(
      "readings",
    );
  });

  it("draws a single reading as a bar, not a lone dot", () => {
    expect(
      deriveChartSpec(daySeries("pulse", [null, 62, null], "bpm")),
    ).toEqual({
      kind: "bar",
      x: "day",
      series: ["value"],
      orientation: "vertical",
    });
  });

  it("places every scope source as a level or a total", () => {
    expect(METRIC_AGGREGATION_KIND.steps).toBe("total");
    expect(METRIC_AGGREGATION_KIND.daylight).toBe("total");
    expect(METRIC_AGGREGATION_KIND.sleep).toBe("level");
    expect(METRIC_AGGREGATION_KIND.mood).toBe("level");
  });
});

describe("deriveChartSpec: category counts", () => {
  it("draws up to six categories as vertical bars of the count column", () => {
    expect(deriveChartSpec(categories([3, 5, 1, 2, 4, 6]))).toEqual({
      kind: "bar",
      x: "sport",
      series: ["sessions"],
      orientation: "vertical",
    });
  });

  it("turns horizontal above six categories", () => {
    const spec = deriveChartSpec(categories([3, 5, 1, 2, 4, 6, 7]));
    expect(spec).toMatchObject({ kind: "bar", orientation: "horizontal" });
  });

  it("draws nothing for a fractional count", () => {
    expect(deriveChartSpec(categories([3, 1.5]))).toBeNull();
  });

  it("draws nothing for a negative count", () => {
    expect(deriveChartSpec(categories([3, -1]))).toBeNull();
  });

  it("draws nothing without a count", () => {
    expect(deriveChartSpec(categories([null, null]))).toBeNull();
  });

  it("folds everything past the top eight into one other bar", () => {
    const counts = [1, 9, 2, 8, 3, 7, 4, 6, 5, 10, 1];
    const table = categories(counts);
    const spec = deriveChartSpec(table);
    if (spec?.kind !== "bar") throw new Error("expected a bar chart");
    const rows = chartCategoryRows(table, spec, "Other");
    expect(rows).toHaveLength(CATEGORY_TOP_N + 1);
    expect(rows.slice(0, 3).map((row) => row.value)).toEqual([10, 9, 8]);
    expect(rows[CATEGORY_TOP_N]).toEqual({
      label: "Other",
      value: 2 + 1 + 1,
      other: true,
    });
    const total = counts.reduce((sum, value) => sum + value, 0);
    expect(rows.reduce((sum, row) => sum + row.value, 0)).toBe(total);
  });

  it("adds no other bar when every category fits", () => {
    const table = categories([2, 1, 3]);
    const spec = deriveChartSpec(table);
    if (spec?.kind !== "bar") throw new Error("expected a bar chart");
    expect(
      chartCategoryRows(table, spec, "Other").some((row) => row.other),
    ).toBe(false);
  });
});

describe("deriveChartSpec: shapes without a chart of their own", () => {
  it("draws nothing for a list of single values (lab results)", () => {
    const table: CoachResultTable = {
      ...categories([1, 2]),
      shape: "single",
    };
    expect(deriveChartSpec(table)).toBeNull();
  });

  it("draws nothing for a distribution without its bins", () => {
    const table: CoachResultTable = {
      ...categories([1, 2]),
      shape: "distribution",
      chart: null,
    };
    expect(deriveChartSpec(table)).toBeNull();
  });
});

describe("buildHistogram", () => {
  const spread = (from: number, step: number, n: number) =>
    Array.from({ length: n }, (_, i) => from + (i % 7) * step);

  it("needs at least ten values", () => {
    expect(buildHistogram(spread(60, 3, 9), "pulse", "bpm")).toBeNull();
    expect(buildHistogram(spread(60, 3, 10), "pulse", "bpm")).not.toBeNull();
  });

  it.each([
    ["bp", "mmHg", 110, 5],
    ["pulse", "bpm", 55, 5],
    ["weight", "kg", 79, 0.5],
    ["sleep", "min", 360, 30],
    ["glucose", "mg/dL", 85, 10],
    ["steps", "steps", 4000, 1000],
  ] as const)("bins %s in its fixed width", (domain, unit, base, width) => {
    const values = Array.from({ length: 12 }, (_, i) => base + i * width * 0.7);
    const bins = buildHistogram(values, domain, unit);
    if (!bins) throw new Error("expected bins");
    for (const bin of bins) expect(bin.to - bin.from).toBeCloseTo(width, 9);
    expect(bins[0].from % width).toBeCloseTo(0, 9);
  });

  it("counts every value exactly once, the highest in the last bin", () => {
    const values = [120, 121, 124.9, 125, 126, 130, 131, 140, 140, 118];
    const bins = buildHistogram(values, "bp", "mmHg");
    if (!bins) throw new Error("expected bins");
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(values.length);
    expect(bins[0]).toEqual({ from: 115, to: 120, count: 1 });
    expect(bins.find((bin) => bin.from === 120)?.count).toBe(3);
    expect(bins.find((bin) => bin.from === 125)?.count).toBe(2);
    expect(bins[bins.length - 1]).toEqual({ from: 140, to: 145, count: 2 });
  });

  it("keeps an empty bin between readings as a zero", () => {
    const values = [...Array(5).fill(60), ...Array(5).fill(80)];
    const bins = buildHistogram(values, "pulse", "bpm");
    if (!bins) throw new Error("expected bins");
    expect(bins.map((bin) => bin.count)).toEqual([5, 0, 0, 0, 5]);
  });

  it("widens a fixed width until at most twenty bins remain", () => {
    const values = Array.from({ length: 30 }, (_, i) => 1000 + i * 1000);
    const bins = buildHistogram(values, "steps", "steps");
    if (!bins) throw new Error("expected bins");
    expect(bins.length).toBeLessThanOrEqual(HISTOGRAM_MAX_BINS);
    expect(bins[0].to - bins[0].from).toBe(2000);
  });

  it("ignores the glucose width when the table is not in mg/dL", () => {
    const values = Array.from({ length: 20 }, (_, i) => 4.5 + i * 0.2);
    const bins = buildHistogram(values, "glucose", "mmol/L");
    if (!bins) throw new Error("expected bins");
    expect(bins[0].to - bins[0].from).toBeLessThan(10);
    expect(bins.length).toBeGreaterThanOrEqual(HISTOGRAM_MIN_BINS);
  });

  it("holds Freedman–Diaconis to five to twenty bins", () => {
    // A tight cluster with one far outlier: raw FD would give hundreds.
    const wide = [...Array.from({ length: 200 }, (_, i) => 50 + (i % 5)), 900];
    const wideBins = buildHistogram(wide, "vo2_max", undefined);
    // Evenly spread values over a short range: raw FD would give two.
    const narrow = Array.from({ length: 12 }, (_, i) => 30 + i);
    const narrowBins = buildHistogram(narrow, "vo2_max", undefined);
    for (const bins of [wideBins, narrowBins]) {
      if (!bins) throw new Error("expected bins");
      expect(bins.length).toBeGreaterThanOrEqual(HISTOGRAM_MIN_BINS);
      expect(bins.length).toBeLessThanOrEqual(HISTOGRAM_MAX_BINS);
    }
  });

  it("puts identical values in one bin", () => {
    const bins = buildHistogram(Array(12).fill(37.2), "body_temp", "°C");
    expect(bins).toHaveLength(1);
    expect(bins?.[0].count).toBe(12);
  });

  it("is deterministic", () => {
    const values = Array.from({ length: 50 }, (_, i) => 60 + ((i * 7) % 23));
    expect(buildHistogram(values, "pulse", "bpm")).toEqual(
      buildHistogram([...values].reverse(), "pulse", "bpm"),
    );
  });
});

describe("buildDistributionTable", () => {
  const values = [58, 61, 62, 64, 66, 66, 67, 70, 71, 74, null, 63];

  it("turns a day table into counts per range with a histogram", () => {
    const table = buildDistributionTable(
      daySeries("pulse", values, "bpm"),
      LABELS,
    );
    if (!table) throw new Error("expected a distribution");
    expect(table.shape).toBe("distribution");
    expect(table.titleKey).toBe("coach.result.title.distribution");
    expect(table.columns.map((column) => column.key)).toEqual([
      "range",
      "count",
    ]);
    expect(table.rows[0]).toEqual(["55–60 bpm", 1]);
    expect(table.chart).toMatchObject({
      kind: "histogram",
      column: "value",
      unit: "bpm",
    });
    expect(table.chartKind).toBe("histogram");
    expect(table.rowCount).toBe(table.rows.length);
    const counted = table.rows.reduce(
      (sum, row) => sum + (row[1] as number),
      0,
    );
    expect(counted).toBe(values.filter((v) => v !== null).length);
    // The stored histogram survives a second pass through the heuristic.
    expect(deriveChartSpec(table)).toEqual(table.chart);
  });

  it("formats bin edges in the reply's locale", () => {
    const weights = Array.from({ length: 12 }, (_, i) => 80 + i * 0.3);
    const table = buildDistributionTable(daySeries("weight", weights, "kg"), {
      ...LABELS,
      localeTag: "de-DE",
    });
    expect(table?.rows[0]?.[0]).toBe("80,0–80,5 kg");
  });

  it("builds nothing from fewer than ten values", () => {
    expect(
      buildDistributionTable(daySeries("pulse", [60, 61, 62], "bpm"), LABELS),
    ).toBeNull();
  });

  it("builds nothing from a table by week", () => {
    const table = timeSeries({
      domain: "pulse",
      granularity: "week",
      columns: [DAY, valueColumn("value", "bpm")],
      rows: values.map((value, index) => [dayKey(index * 7), value]),
    });
    expect(buildDistributionTable(table, LABELS)).toBeNull();
  });

  it("builds nothing from category counts", () => {
    expect(
      buildDistributionTable(
        categories([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        LABELS,
      ),
    ).toBeNull();
  });

  it("names the column it binned when the table has two", () => {
    const table = timeSeries({
      domain: "bp",
      columns: [
        DAY,
        { ...valueColumn("systolic", "mmHg"), label: "Systolic" },
        { ...valueColumn("diastolic", "mmHg"), label: "Diastolic" },
      ],
      rows: Array.from({ length: 12 }, (_, i) => [dayKey(i), 120 + i, 80]),
    });
    const distribution = buildDistributionTable(table, LABELS);
    expect(distribution?.columns[0]?.label).toBe("Range (Systolic)");
    expect(distribution?.chart).toMatchObject({ column: "systolic" });
  });
});
