/**
 * The value axis of a Coach result chart steps evenly: the chart hands
 * recharts explicit ticks on an explicit domain instead of letting it place
 * (and thin) them, which left labels like 75, 90, 105, 135 on a blood
 * pressure line. Recharts is replaced by pass-through parts so the props the
 * chart gives its y axis can be read without a browser layout.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const yAxisProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Leaf = () => null;
  return {
    ResponsiveContainer: Pass,
    LineChart: Pass,
    BarChart: Pass,
    CartesianGrid: Leaf,
    Line: Leaf,
    Bar: Leaf,
    Tooltip: Leaf,
    XAxis: Leaf,
    YAxis: (props: Record<string, unknown>) => {
      yAxisProps.push(props);
      return null;
    },
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import type { CoachResultTable } from "@/lib/ai/coach/types";

import { CoachResultChart } from "../result-chart";

function bpTable(rows: CoachResultTable["rows"]): CoachResultTable {
  return {
    ref: "r1",
    source: {
      tool: "get_metric_table",
      domain: "bp",
      window: "last30days",
      period: "current",
      granularity: "day",
    },
    shape: "timeSeries",
    titleKey: "coach.result.title.byDay",
    title: "Blood pressure by day",
    rowCount: rows.length,
    chartKind: "line",
    displayed: true,
    columns: [
      { key: "day", kind: "period", labelKey: "k", label: "Day" },
      { key: "systolic", kind: "number", labelKey: "k", label: "Systolic" },
      { key: "diastolic", kind: "number", labelKey: "k", label: "Diastolic" },
    ],
    rows,
    truncated: false,
    chart: { kind: "line", x: "day", series: ["systolic", "diastolic"] },
  };
}

function renderChart(result: CoachResultTable) {
  renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <CoachResultChart result={result} otherLabel="Other" label="Chart" />
    </I18nProvider>,
  );
  return yAxisProps.at(-1)!;
}

beforeEach(() => {
  yAxisProps.length = 0;
});

describe("CoachResultChart value axis", () => {
  it("gives a blood pressure line evenly spaced ticks on its domain", () => {
    const props = renderChart(
      bpTable([
        ["2026-09-01", 134, 88],
        ["2026-09-02", null, null],
        ["2026-09-03", 121, 78],
      ]),
    );
    const ticks = props.ticks as number[];
    expect(ticks).toEqual([60, 80, 100, 120, 140]);
    expect(props.domain).toEqual([60, 140]);
    // Every tick is drawn; none is thinned into an uneven step.
    expect(props.interval).toBe(0);
  });

  it("starts vertical bars at zero", () => {
    const props = renderChart({
      ...bpTable([
        ["2026-09-01", 3200, null],
        ["2026-09-02", 11050, null],
      ]),
      chart: {
        kind: "bar",
        x: "day",
        series: ["systolic"],
        orientation: "vertical",
      },
      chartKind: "bar",
    });
    expect(props.domain).toEqual([0, 15000]);
    expect(props.ticks).toEqual([0, 5000, 10000, 15000]);
  });
});
