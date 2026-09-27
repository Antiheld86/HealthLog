/**
 * v1.39.4 — collecting a turn's tables, and the projections of the older
 * tools' results into tables.
 */
import { describe, expect, it } from "vitest";

import type { CoachResultTable } from "@/lib/ai/coach/types";
import {
  COACH_SOURCE_SNAPSHOT_KEY,
  METRIC_SERIES_EXCLUDED_SOURCES,
} from "@/lib/ai/coach/tools/source-keys";
import { coachScopeSourceSchema } from "@/lib/ai/coach/types";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import { parseCoachToolArgs } from "@/lib/ai/coach/tools/definitions";

import { RESULT_TABLE_MAX_ROWS, projectResults } from "../project";
import { projectCompliance, projectLabs } from "../projections";
import { METRIC_TABLE_EXCLUDED_SOURCES } from "../metric-table-tool";

function table(ref: string, rows = 1): CoachResultTable {
  return {
    ref,
    source: {
      tool: "get_metric_table",
      domain: "pulse",
      window: "lastYear",
      period: "current",
      granularity: "day",
    },
    shape: "timeSeries",
    titleKey: "coach.result.title.byDay",
    title: "Pulse by day",
    rowCount: rows,
    chartKind: "line",
    displayed: true,
    columns: [],
    rows: Array.from({ length: rows }, (_, i) => [String(i), i]),
    truncated: false,
    chart: { kind: "line", x: "day", series: ["value"] },
  };
}

describe("projectResults", () => {
  it("collects the settled tables in ref order, undisplayed and chartless", () => {
    const out = projectResults({
      locale: "en",
      calls: [
        {
          name: "get_metric_table",
          result: { present: true, table: table("r2") },
        },
        { name: "get_sleep", result: { present: false, reason: "no_data" } },
        {
          name: "get_metric_table",
          result: { present: true, table: table("r1") },
        },
        // A duplicate name never yields a second table.
        {
          name: "get_metric_table",
          result: { present: true, table: table("r1") },
        },
      ],
    });
    expect(out.map((t) => t.ref)).toEqual(["r1", "r2"]);
    expect(out.every((t) => !t.displayed && t.chart === null)).toBe(true);
  });

  it("keeps the view a table shown again was given", () => {
    const shownAgain = {
      ...table("r1", 5),
      reusedFrom: { messageId: "m-a1", ref: "r2" },
    };
    const [asChart, asTable] = projectResults({
      locale: "en",
      calls: [
        { name: "show_result", result: { present: true, table: shownAgain } },
        {
          name: "show_result",
          result: {
            present: true,
            table: { ...shownAgain, ref: "r2", chart: null, chartKind: null },
          },
        },
      ],
    });
    expect(asChart.chart).toEqual({
      kind: "line",
      x: "day",
      series: ["value"],
    });
    expect(asChart.chartKind).toBe("line");
    expect(asTable.chart).toBeNull();
    expect(asTable.chartKind).toBeNull();
  });

  it("trims a table to the row ceiling and says so", () => {
    const [out] = projectResults({
      locale: "en",
      calls: [
        {
          name: "show_result",
          result: {
            present: true,
            table: table("r1", RESULT_TABLE_MAX_ROWS + 5),
          },
        },
      ],
    });
    expect(out.rows).toHaveLength(RESULT_TABLE_MAX_ROWS);
    expect(out.rowCount).toBe(RESULT_TABLE_MAX_ROWS + 5);
    expect(out.truncated).toBe(true);
  });
});

describe("projectLabs", () => {
  it("lists the latest reading per analyte with its day and range", () => {
    const out = projectLabs(
      {
        recent: [
          {
            analyte: "LDL",
            value: 3.1,
            valueText: null,
            unit: "mmol/L",
            referenceLow: null,
            referenceHigh: 3,
            takenAt: "2026-09-01T23:30:00.000Z",
          },
          {
            analyte: "Urine protein",
            value: null,
            valueText: "negative",
            unit: "",
            referenceLow: null,
            referenceHigh: null,
            takenAt: "2026-08-01T08:00:00.000Z",
          },
        ],
      },
      {
        ref: "r2",
        locale: "en",
        window: "last30days",
        timeZone: "Pacific/Auckland",
      },
    );
    expect(out?.shape).toBe("single");
    expect(out?.source.window).toBe("lastYear");
    expect(out?.rows).toEqual([
      ["LDL", 3.1, "mmol/L", "2026-09-02", "≤ 3"],
      ["Urine protein", "negative", null, "2026-08-01", null],
    ]);
  });
});

describe("projectCompliance", () => {
  it("folds recent days and older weeks into whole weeks", () => {
    const out = projectCompliance(
      {
        compliance: {
          rate: 90,
          timeline: {
            // ISO week 38 of 2026 starts Monday 14 September.
            weekly: [{ weekISO: "2026-W38", rate: 0.5, taken: 3, total: 6 }],
            recent: [
              // Sunday 20 September — same week as the older part above.
              { date: "2026-09-20", rate: 1, taken: 1, total: 1 },
              { date: "2026-09-21", rate: 1, taken: 2, total: 2 },
            ],
          },
        },
      },
      { ref: "r1", locale: "en", window: "last30days", timeZone: "UTC" },
    );
    expect(out?.rows).toEqual([
      ["2026-09-14", (4 / 7) * 100, 7],
      ["2026-09-21", 100, 2],
    ]);
  });

  it("is null without a timeline", () => {
    expect(
      projectCompliance(
        { glp1: {} },
        {
          ref: "r1",
          locale: "en",
          window: "last30days",
          timeZone: "UTC",
        },
      ),
    ).toBeNull();
  });
});

describe("get_metric_table covers every source", () => {
  it("reads each source as measurements, mood or sleep, or names the tool that does", () => {
    for (const source of coachScopeSourceSchema.options) {
      const handled =
        source === "mood" ||
        source === "sleep" ||
        METRIC_TABLE_EXCLUDED_SOURCES[source] !== undefined ||
        COACH_SOURCE_MEASUREMENT_TYPES[source].length > 0;
      expect(handled, source).toBe(true);
    }
  });

  it("serves at least every source get_metric_series serves", () => {
    for (const source of Object.keys(COACH_SOURCE_SNAPSHOT_KEY)) {
      if (METRIC_SERIES_EXCLUDED_SOURCES.has(source as never)) continue;
      expect(
        METRIC_TABLE_EXCLUDED_SOURCES[source as never],
        source,
      ).toBeUndefined();
    }
  });
});

describe("parseCoachToolArgs", () => {
  it("validates the two new tools' arguments", () => {
    expect(
      parseCoachToolArgs(
        "get_metric_table",
        '{"metric":"bp","window":"last90days","granularity":"week","period":"yearAgo"}',
      ),
    ).toEqual({
      metric: "bp",
      window: "last90days",
      granularity: "week",
      period: "yearAgo",
    });
    expect(
      parseCoachToolArgs("get_metric_table", '{"metric":"bp","period":"soon"}'),
    ).toBeUndefined();
    expect(parseCoachToolArgs("show_result", '{"ref":"m3.r1"}')).toEqual({
      ref: "m3.r1",
    });
    expect(
      parseCoachToolArgs("show_result", '{"ref":"conversation/other/r1"}'),
    ).toBeUndefined();
  });
});
