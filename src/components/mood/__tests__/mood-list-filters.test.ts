/**
 * URL round trip for the mood list filters (`?mood&source&from&to`) — the
 * vault-utils contract applied to this surface: parsing is lenient (a
 * hand-edited URL drops the invalid facet, never breaks the page),
 * serialisation omits defaults, and parse(serialise(x)) is identity so deep
 * links stay stable.
 */
import { describe, expect, it } from "vitest";

import {
  moodListFiltersToSearch,
  parseMoodListSearchParams,
  type MoodListFilters,
} from "../mood-list-filters";

describe("parseMoodListSearchParams", () => {
  it.each<[string, MoodListFilters]>([
    ["", {}],
    ["mood=GUT", { mood: "GUT" }],
    ["mood=LAUSIG&source=TELEGRAM", { mood: "LAUSIG", source: "TELEGRAM" }],
    [
      "from=2026-05-01&to=2026-05-31",
      { fromDay: "2026-05-01", toDay: "2026-05-31" },
    ],
    // MOODLOG is legacy provenance — rows keep their label, so the filter
    // must keep resolving it.
    ["source=MOODLOG", { source: "MOODLOG" }],
  ])("parses %j", (search, expected) => {
    expect(parseMoodListSearchParams(new URLSearchParams(search))).toEqual(
      expected,
    );
  });

  it("drops facets a stale or hand-edited URL cannot honour", () => {
    expect(
      parseMoodListSearchParams(
        new URLSearchParams(
          "mood=ECSTATIC&source=NOT_A_SOURCE&from=05-01-2026&to=yesterday",
        ),
      ),
    ).toEqual({});
  });
});

describe("moodListFiltersToSearch", () => {
  it("serialises the empty filter set to an empty string (bare URL)", () => {
    expect(moodListFiltersToSearch({})).toBe("");
  });

  it.each<MoodListFilters>([
    {},
    { mood: "SUPER_GUT" },
    { mood: "OKAY", source: "WEB" },
    { fromDay: "2026-05-01", toDay: "2026-05-31" },
    {
      mood: "SCHLECHT",
      source: "DAYLIO",
      fromDay: "2026-01-01",
      toDay: "2026-12-31",
    },
  ])("round-trips %j", (filters) => {
    expect(
      parseMoodListSearchParams(
        new URLSearchParams(moodListFiltersToSearch(filters)),
      ),
    ).toEqual(filters);
  });
});
