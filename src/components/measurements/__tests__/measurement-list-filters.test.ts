/**
 * URL round trip for the measurements list filters (`?type&source&from&to&
 * min&max`) — the vault-utils contract applied to this surface: parsing is
 * lenient (a hand-edited URL drops the invalid facet, never breaks the
 * page), serialisation omits defaults, and parse(serialise(x)) is identity
 * so deep links stay stable.
 */
import { describe, expect, it } from "vitest";

import {
  measurementListFiltersToSearch,
  numericInputOrUndefined,
  parseMeasurementListSearchParams,
  type MeasurementListFilters,
} from "../measurement-list-filters";

describe("parseMeasurementListSearchParams", () => {
  it.each<[string, MeasurementListFilters]>([
    ["", {}],
    ["type=WEIGHT", { type: "WEIGHT" }],
    ["type=WEIGHT&source=WITHINGS", { type: "WEIGHT", source: "WITHINGS" }],
    [
      "from=2026-05-01&to=2026-05-31",
      { fromDay: "2026-05-01", toDay: "2026-05-31" },
    ],
    ["min=60&max=90.5", { valueMin: "60", valueMax: "90.5" }],
    [
      "type=PULSE&source=APPLE_HEALTH&from=2026-01-01&min=-5",
      {
        type: "PULSE",
        source: "APPLE_HEALTH",
        fromDay: "2026-01-01",
        valueMin: "-5",
      },
    ],
  ])("parses %j", (search, expected) => {
    expect(
      parseMeasurementListSearchParams(new URLSearchParams(search)),
    ).toEqual(expected);
  });

  it("drops facets a stale or hand-edited URL cannot honour", () => {
    expect(
      parseMeasurementListSearchParams(
        new URLSearchParams(
          "type=NOT_A_TYPE&source=NOT_A_SOURCE&from=2026-1-1&to=yesterday&min=abc&max=1e999",
        ),
      ),
    ).toEqual({});
    // 1e999 is Infinity — not finite, so the bound is dropped too.
    expect(numericInputOrUndefined("1e999")).toBeUndefined();
  });
});

describe("measurementListFiltersToSearch", () => {
  it("serialises the empty filter set to an empty string (bare URL)", () => {
    expect(measurementListFiltersToSearch({})).toBe("");
  });

  it.each<MeasurementListFilters>([
    {},
    { type: "WEIGHT" },
    { type: "BLOOD_PRESSURE_SYS", source: "MANUAL" },
    { fromDay: "2026-05-01", toDay: "2026-05-31" },
    { valueMin: "60", valueMax: "90.5" },
    {
      type: "PULSE",
      source: "APPLE_HEALTH",
      fromDay: "2026-01-01",
      toDay: "2026-12-31",
      valueMin: "40",
      valueMax: "180",
    },
  ])("round-trips %j", (filters) => {
    expect(
      parseMeasurementListSearchParams(
        new URLSearchParams(measurementListFiltersToSearch(filters)),
      ),
    ).toEqual(filters);
  });
});
