/**
 * v1.39.4 — where a reply's tables go and how they first show: the ones the
 * answer referenced under the prose, the rest under "Data used", a chart
 * first only for a referenced table that has one, and the chart's plot named
 * as an image that points at the table. SSR harness, like the other Coach
 * panel tests; the toggle itself is exercised in the browser suite.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import type { CoachResultTable as Table } from "@/lib/ai/coach/types";

import { CoachResults, countResultsInSection } from "../coach-results";
import { CoachResultChart } from "../result-chart";
import { selectCoachChartTokens } from "../chat-bubble";

function table(overrides: Partial<Table> = {}): Table {
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
    rowCount: 2,
    chartKind: "line",
    displayed: true,
    columns: [
      {
        key: "day",
        kind: "period",
        labelKey: "coach.result.column.day",
        label: "Day",
      },
      {
        key: "systolic",
        kind: "number",
        labelKey: "coach.result.column.systolic",
        label: "Systolic",
        unit: "mmHg",
        decimals: 0,
      },
      {
        key: "diastolic",
        kind: "number",
        labelKey: "coach.result.column.diastolic",
        label: "Diastolic",
        unit: "mmHg",
        decimals: 0,
      },
    ],
    rows: [
      ["2026-09-01", 124, 81],
      ["2026-09-02", 121, 79],
    ],
    truncated: false,
    chart: { kind: "line", x: "day", series: ["systolic", "diastolic"] },
    ...overrides,
  };
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function results(live: Table[], section: "displayed" | "dataUsed") {
  return render(
    <CoachResults
      conversationId="c1"
      messageId="m1"
      metas={[]}
      live={live}
      section={section}
    />,
  );
}

describe("CoachResults", () => {
  it("opens a referenced table with a chart on the chart", () => {
    const html = results([table()], "displayed");
    expect(html).toContain('data-slot="coach-result-chart"');
    expect(html).toMatch(/<figure[^>]*aria-labelledby="([^"]+)"/);
    expect(html).toMatch(/<figcaption[\s\S]*Blood pressure by day/);
    expect(html).not.toContain('data-slot="coach-result-table"');
  });

  it("marks the chart segment as the pressed one", () => {
    const html = results([table()], "displayed");
    const chartButton = html.match(
      /<button[^>]*data-slot="coach-result-view-chart"[^>]*>/,
    )?.[0];
    const tableButton = html.match(
      /<button[^>]*data-slot="coach-result-view-table"[^>]*>/,
    )?.[0];
    expect(chartButton).toContain('aria-pressed="true"');
    expect(tableButton).toContain('aria-pressed="false"');
  });

  it("opens a table without a chart as a table, with no toggle", () => {
    const html = results(
      [table({ chart: null, chartKind: null })],
      "displayed",
    );
    expect(html).toContain('data-slot="coach-result-table"');
    expect(html).not.toContain("coach-result-view-");
  });

  it("keeps an unreferenced table out of the answer", () => {
    const html = results([table({ displayed: false })], "displayed");
    expect(html).toBe("");
  });

  it("lists an unreferenced table under Data used, as a table first", () => {
    const html = results(
      [table(), table({ ref: "r2", displayed: false })],
      "dataUsed",
    );
    expect(html).toContain("Data used (1)");
    expect(html).toContain('data-ref="r2"');
    expect(html).not.toContain('data-ref="r1"');
    expect(html).toContain('data-slot="coach-result-table"');
    // The chart stays one tap away.
    expect(html).toContain('data-slot="coach-result-view-chart"');
  });

  it("renders no Data used block when the answer referenced every table", () => {
    expect(results([table()], "dataUsed")).toBe("");
  });

  it("counts a section from the metadata alone", () => {
    const metas = [
      { displayed: true },
      { displayed: false },
      { displayed: false },
    ];
    expect(countResultsInSection(metas, "displayed")).toBe(1);
    expect(countResultsInSection(metas, "dataUsed")).toBe(2);
  });
});

describe("CoachResultChart", () => {
  const label =
    "Blood pressure by day, shown as a chart. The table view lists every value.";

  it("names the plot as one image that points at the table", () => {
    const html = render(
      <CoachResultChart result={table()} otherLabel="Other" label={label} />,
    );
    expect(html).toMatch(new RegExp(`<div role="img" aria-label="${label}"`));
  });

  it("gives two series legend buttons outside the image", () => {
    const html = render(
      <CoachResultChart result={table()} otherLabel="Other" label={label} />,
    );
    const legend = html.match(
      /<div[^>]*data-slot="coach-result-chart-legend"[\s\S]*?<\/div>/,
    )?.[0];
    expect(legend?.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(legend).toContain("Systolic");
    expect(legend).toContain("Diastolic");
    expect(html.indexOf("coach-result-chart-legend")).toBeLessThan(
      html.indexOf('role="img"'),
    );
  });

  it("draws one series without a legend", () => {
    const html = render(
      <CoachResultChart
        result={table({
          chart: { kind: "line", x: "day", series: ["systolic"] },
        })}
        otherLabel="Other"
        label={label}
      />,
    );
    expect(html).not.toContain("coach-result-chart-legend");
  });

  it("draws nothing without a spec", () => {
    const html = render(
      <CoachResultChart
        result={table({ chart: null })}
        otherLabel="Other"
        label={label}
      />,
    );
    expect(html).toBe("");
  });
});

describe("selectCoachChartTokens beside result tables", () => {
  it("drops a metric token whose metric a shown table already covers", () => {
    expect(
      selectCoachChartTokens(
        "metric:BLOOD_PRESSURE_SYS and metric:WEIGHT",
        ["bp", "weight"],
        new Set(["bp"]),
      ),
    ).toEqual(["metric:WEIGHT"]);
  });

  it("keeps the token when no table is shown", () => {
    expect(
      selectCoachChartTokens("metric:WEIGHT", ["weight"], new Set()),
    ).toEqual(["metric:WEIGHT"]);
  });
});
