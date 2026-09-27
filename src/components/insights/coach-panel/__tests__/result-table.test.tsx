/**
 * v1.39.4 — the result table's anatomy: caption with title and method,
 * column headers scoped, numbers right-aligned in tabular figures, absence
 * shown as a dash and announced, and the latest twelve rows before
 * "Show all". SSR harness, like the other Coach panel tests; the toggle
 * itself is exercised in the browser suite.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { CoachResultTable as Table } from "@/lib/ai/coach/types";

import { CoachResultTable, RESULT_TABLE_PREVIEW_ROWS } from "../result-table";

function table(rowCount: number): Table {
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
    rowCount,
    chartKind: null,
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
        key: "readings",
        kind: "count",
        labelKey: "coach.result.column.readings",
        label: "Readings",
      },
    ],
    rows: Array.from({ length: rowCount }, (_, i) => [
      `2026-09-${String(i + 1).padStart(2, "0")}`,
      i === 1 ? null : 120.4 + i,
      i === 1 ? null : 1,
    ]),
    truncated: false,
    chart: null,
  };
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("CoachResultTable", () => {
  it("captions the table with its title and the method line", () => {
    const html = render(
      <CoachResultTable result={table(3)} method="30 readings, daily means" />,
    );
    expect(html).toMatch(
      /<caption[^>]*>[\s\S]*Blood pressure by day[\s\S]*30 readings, daily means[\s\S]*<\/caption>/,
    );
  });

  it("scopes headers to columns and right-aligns numbers in tabular figures", () => {
    const html = render(<CoachResultTable result={table(3)} />);
    expect(html.match(/<th[^>]*scope="col"/g)).toHaveLength(3);
    expect(html).toContain("(mmHg)");
    expect(html).toMatch(/<td[^>]*text-right tabular-nums[^>]*>120<\/td>/);
  });

  it("shows a day without a reading as a dash and says so to a screen reader", () => {
    const html = render(<CoachResultTable result={table(3)} />);
    expect(html).toContain(
      '<span class="text-muted-foreground" aria-hidden="true">—</span>',
    );
    expect(html).toContain('<span class="sr-only">no reading</span>');
    expect(html).not.toMatch(/>0<\/td>/);
  });

  it("previews the latest twelve periods of a time series, oldest first", () => {
    const html = render(<CoachResultTable result={table(20)} />);
    // Row i holds 120.4 + i, shown without decimals: the latest twelve of
    // twenty are rows 8..19, values 128..139.
    expect(html).not.toMatch(/>120<\/td>/);
    expect(html).not.toMatch(/>127<\/td>/);
    expect(html).toMatch(/>128<\/td>/);
    expect(html).toMatch(/>139<\/td>/);
    expect(html.indexOf(">128</td>")).toBeLessThan(html.indexOf(">139</td>"));
  });

  it("previews the first twelve rows of a table that is not a time series", () => {
    const html = render(
      <CoachResultTable result={{ ...table(20), shape: "categoryCounts" }} />,
    );
    expect(html).toMatch(/>120<\/td>/);
    expect(html).not.toMatch(/>139<\/td>/);
  });

  it("keeps the title, copy and view controls above the scrolling table", () => {
    const html = render(
      <CoachResultTable
        result={table(20)}
        method="From an earlier answer"
        toolbar={<span data-slot="test-toolbar" />}
      />,
    );
    const header = html.indexOf('data-slot="coach-result-table-header"');
    const scroller = html.indexOf('data-slot="coach-result-table-scroll"');
    expect(header).toBeGreaterThan(-1);
    expect(scroller).toBeGreaterThan(header);
    expect(html.indexOf('data-slot="test-toolbar"')).toBeLessThan(scroller);
    expect(html).toMatch(/<caption class="sr-only">/);
    expect(html).toMatch(
      /data-slot="coach-result-table"[^>]*class="[^"]*\bw-full\b/,
    );
  });

  it("shows twelve rows and offers the rest", () => {
    const html = render(<CoachResultTable result={table(20)} />);
    expect(html.match(/<tr[^>]*data-slot="table-row"/g)).toHaveLength(
      RESULT_TABLE_PREVIEW_ROWS + 1,
    );
    const button = html.match(
      /<button[^>]*aria-expanded="false"[^>]*>[^<]*<\/button>/,
    )?.[0];
    expect(button).toContain("Show all (20)");
    const controls = button?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
  });

  it("offers nothing to expand for a short table", () => {
    const html = render(<CoachResultTable result={table(5)} />);
    expect(html).not.toContain("aria-expanded");
  });
});
