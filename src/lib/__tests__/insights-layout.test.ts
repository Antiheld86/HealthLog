/**
 * v1.15.11 — insights layout model v2.
 *
 * The layout blob grew a `sections` array on top of the existing per-
 * metric `tiles` list. These tests pin the v2 contract that the
 * `/insights` page (web) and the iOS client share: a v1 blob resolves
 * forward untouched, section reorder/hide round-trips, unknown section
 * ids auto-merge invisible then drop on serialize, and an omitted
 * `sections` / `tiles` field falls back to defaults.
 */
import { describe, it, expect } from "vitest";
import {
  INSIGHTS_SECTION_IDS,
  INSIGHTS_TILE_IDS,
  DEFAULT_INSIGHTS_LAYOUT,
  resolveInsightsLayout,
  serializeInsightsLayout,
  orderedVisibleSectionIds,
  normalizeInsightsTileId,
  resolveTileLayout,
} from "@/lib/insights-layout";

describe("normalizeInsightsTileId", () => {
  it("only resolves own legacy aliases", () => {
    expect(normalizeInsightsTileId("blutdruck")).toBe("blood-pressure");

    for (const id of ["toString", "constructor", "__proto__"]) {
      expect(normalizeInsightsTileId(id)).toBe(id);
    }
  });
});

describe("insights-layout v2 — section id universe", () => {
  it("carries exactly the default sections in render order", () => {
    expect([...INSIGHTS_SECTION_IDS]).toEqual([
      "wellness-scores",
      "daily-briefing",
      "vitals",
      "trends",
      "period-review",
      "cycle-summary",
      "signals",
      "rhythm-events",
      "health-status",
      "breathing",
      "labs-changes",
      "ecg",
    ]);
  });

  it("defaults every section visible with a dense 0-based order", () => {
    expect(DEFAULT_INSIGHTS_LAYOUT.version).toBe(2);
    expect(DEFAULT_INSIGHTS_LAYOUT.sections.length).toBe(
      INSIGHTS_SECTION_IDS.length,
    );
    DEFAULT_INSIGHTS_LAYOUT.sections.forEach((s, i) => {
      expect(s.visible).toBe(true);
      expect(s.order).toBe(i);
      expect(s.id).toBe(INSIGHTS_SECTION_IDS[i]);
    });
  });
});

describe("resolveInsightsLayout — v1 → v2 forward upgrade", () => {
  it("fills all sections default-visible and leaves tiles untouched for a v1 blob", () => {
    const v1blob = {
      version: 1,
      tiles: [
        { id: "overview", visible: true, order: 0 },
        { id: "blood-pressure", visible: false, order: 1 },
      ],
    };
    const resolved = resolveInsightsLayout(v1blob);

    // Upgraded to v2 with the full default section set, all visible.
    expect(resolved.version).toBe(2);
    expect(resolved.sections.length).toBe(INSIGHTS_SECTION_IDS.length);
    for (const s of resolved.sections) expect(s.visible).toBe(true);
    expect(resolved.sections.map((s) => s.id)).toEqual([
      ...INSIGHTS_SECTION_IDS,
    ]);

    // The two saved tiles survive verbatim at the head; the rest merge.
    expect(resolved.tiles[0]).toEqual({
      id: "overview",
      visible: true,
      order: 0,
    });
    expect(resolved.tiles[1]).toEqual({
      id: "blood-pressure",
      visible: false,
      order: 1,
    });

    // v1.22 — a late-added default tile the saved blob never enumerated
    // (e.g. `steps`, which entered the set in v1.12) merges in
    // default-VISIBLE, matching the fresh-account default. The old
    // force-hidden merge silently dropped its nav pill on every read of an
    // existing or iOS-synced layout.
    const steps = resolved.tiles.find((t) => t.id === "steps");
    expect(steps?.visible).toBe(true);
  });

  it("returns the full default layout for garbage input", () => {
    expect(resolveInsightsLayout(null).sections.length).toBe(
      INSIGHTS_SECTION_IDS.length,
    );
    expect(resolveInsightsLayout({ version: 2 }).sections.length).toBe(
      INSIGHTS_SECTION_IDS.length,
    );
  });
});

describe("resolveInsightsLayout — section semantics", () => {
  it("auto-merges a missing default section default-invisible", () => {
    const resolved = resolveInsightsLayout({
      version: 2,
      sections: [{ id: "vitals", visible: true, order: 0 }],
      tiles: [{ id: "overview", visible: true, order: 0 }],
    });
    const vitals = resolved.sections.find((s) => s.id === "vitals");
    const trends = resolved.sections.find((s) => s.id === "trends");
    expect(vitals?.visible).toBe(true);
    // Every section the blob omitted merges in default-invisible.
    expect(trends?.visible).toBe(false);
    expect(resolved.sections.length).toBe(INSIGHTS_SECTION_IDS.length);
  });

  it("drops an unknown section id (auto-merge then filter)", () => {
    // `resolveInsightsLayout` takes `unknown` (a raw JSON blob from the
    // column), so a garbage section id models a malformed/forward blob.
    const blob: unknown = {
      version: 2,
      sections: [
        { id: "vitals", visible: true, order: 0 },
        { id: "not-a-section", visible: true, order: 1 },
      ],
      tiles: [{ id: "overview", visible: true, order: 0 }],
    };
    const resolved = resolveInsightsLayout(blob);
    expect(
      resolved.sections.some((s) => (s.id as string) === "not-a-section"),
    ).toBe(false);
    expect(resolved.sections.length).toBe(INSIGHTS_SECTION_IDS.length);
  });

  it("dedupes a repeated section id, keeping the first occurrence", () => {
    const resolved = resolveInsightsLayout({
      version: 2,
      sections: [
        { id: "vitals", visible: true, order: 0 },
        { id: "vitals", visible: false, order: 1 },
      ],
      tiles: [{ id: "overview", visible: true, order: 0 }],
    });
    const vitalsRows = resolved.sections.filter((s) => s.id === "vitals");
    expect(vitalsRows.length).toBe(1);
    expect(vitalsRows[0]?.visible).toBe(true);
  });
});

describe("section reorder + hide round-trips through serialize → resolve", () => {
  it("preserves a custom order + hidden flag", () => {
    const reordered = {
      version: 2,
      sections: [
        { id: "trends", visible: true, order: 0 },
        { id: "wellness-scores", visible: false, order: 1 },
        { id: "vitals", visible: true, order: 2 },
      ],
      tiles: [{ id: "overview", visible: true, order: 0 }],
    };
    const serialized = serializeInsightsLayout(reordered);
    const resolved = resolveInsightsLayout(serialized);

    // The three explicitly-ordered sections lead in their chosen order.
    expect(resolved.sections[0]?.id).toBe("trends");
    expect(resolved.sections[1]?.id).toBe("wellness-scores");
    expect(resolved.sections[1]?.visible).toBe(false);
    expect(resolved.sections[2]?.id).toBe("vitals");
    // Orders stay dense 0-based.
    resolved.sections.forEach((s, i) => expect(s.order).toBe(i));
  });
});

describe("serializeInsightsLayout — defaults + dense order", () => {
  it("fills section defaults when the input omits sections", () => {
    const serialized = serializeInsightsLayout({
      version: 2,
      tiles: [{ id: "overview", visible: true, order: 0 }],
    });
    expect(serialized.sections.length).toBe(INSIGHTS_SECTION_IDS.length);
    for (const s of serialized.sections) expect(s.visible).toBe(true);
  });

  it("fills tile defaults when the input omits tiles", () => {
    const serialized = serializeInsightsLayout({
      version: 2,
      sections: [{ id: "vitals", visible: true, order: 0 }],
    });
    expect(serialized.tiles.length).toBe(DEFAULT_INSIGHTS_LAYOUT.tiles.length);
  });

  it("normalises sparse section orders to a dense 0-based sequence", () => {
    const serialized = serializeInsightsLayout({
      version: 2,
      sections: [
        { id: "vitals", visible: true, order: 40 },
        { id: "trends", visible: true, order: 10 },
        { id: "signals", visible: false, order: 99 },
      ],
      tiles: [{ id: "overview", visible: true, order: 0 }],
    });
    // Sorted by input order, then re-numbered 0,1,2.
    expect(
      serialized.sections.map((s) => ({ id: s.id, order: s.order })),
    ).toEqual([
      { id: "trends", order: 0 },
      { id: "vitals", order: 1 },
      { id: "signals", order: 2 },
    ]);
  });

  it("drops unknown section ids on serialize", () => {
    const serialized = serializeInsightsLayout({
      version: 2,
      sections: [
        { id: "vitals", visible: true, order: 0 },
        { id: "bogus", visible: true, order: 1 },
      ],
      tiles: [{ id: "overview", visible: true, order: 0 }],
    });
    expect(serialized.sections.map((s) => s.id)).toEqual(["vitals"]);
  });
});

describe("serializeInsightsLayout — stored-dimension preservation (v1.16.13)", () => {
  it("keeps the stored sections when a PUT omits sections (tiles-only)", () => {
    // The user previously customised sections (a hidden + reordered set).
    const stored = serializeInsightsLayout({
      version: 2,
      sections: [
        { id: "trends", visible: true, order: 0 },
        { id: "vitals", visible: false, order: 1 },
      ],
      tiles: [{ id: "overview", visible: true, order: 0 }],
    });

    // An iOS tiles-only reorder PUT — no `sections` key.
    const serialized = serializeInsightsLayout(
      {
        version: 1,
        tiles: [
          { id: "weight", visible: true, order: 0 },
          { id: "overview", visible: true, order: 1 },
        ],
      },
      stored,
    );

    // Stored sections survive verbatim instead of resetting to defaults.
    expect(
      serialized.sections.map((s) => ({
        id: s.id,
        visible: s.visible,
        order: s.order,
      })),
    ).toEqual([
      { id: "trends", visible: true, order: 0 },
      { id: "vitals", visible: false, order: 1 },
    ]);
    // The PUT's tiles still apply.
    expect(serialized.tiles.map((t) => t.id)).toEqual(["weight", "overview"]);
  });

  it("keeps the stored tiles when a PUT omits tiles (sections-only)", () => {
    const stored = serializeInsightsLayout({
      version: 2,
      sections: [{ id: "vitals", visible: true, order: 0 }],
      tiles: [
        { id: "weight", visible: true, order: 0 },
        { id: "bloodPressure", visible: false, order: 1 },
      ],
    });

    const serialized = serializeInsightsLayout(
      {
        version: 2,
        sections: [
          { id: "trends", visible: true, order: 0 },
          { id: "vitals", visible: false, order: 1 },
        ],
      },
      stored,
    );

    // Stored tiles survive verbatim instead of resetting to defaults.
    expect(
      serialized.tiles.map((t) => ({ id: t.id, visible: t.visible })),
    ).toEqual([
      { id: "weight", visible: true },
      { id: "bloodPressure", visible: false },
    ]);
    expect(serialized.sections.map((s) => s.id)).toEqual(["trends", "vitals"]);
  });

  it("falls back to defaults for an absent dimension when no stored layout is supplied", () => {
    const serialized = serializeInsightsLayout({
      version: 2,
      tiles: [{ id: "overview", visible: true, order: 0 }],
    });
    // First-ever tiles-only PUT still persists a complete v2 blob.
    expect(serialized.sections.length).toBe(INSIGHTS_SECTION_IDS.length);
  });
});

describe("orderedVisibleSectionIds — W2 render-order helper", () => {
  it("returns every section in default order for the default layout", () => {
    expect(orderedVisibleSectionIds(DEFAULT_INSIGHTS_LAYOUT)).toEqual([
      ...INSIGHTS_SECTION_IDS,
    ]);
  });

  it("drops hidden sections and keeps the visible ones in order", () => {
    const layout = resolveInsightsLayout({
      version: 2,
      sections: [
        { id: "wellness-scores", visible: true, order: 0 },
        { id: "daily-briefing", visible: false, order: 1 },
        { id: "vitals", visible: true, order: 2 },
        { id: "trends", visible: false, order: 3 },
        { id: "period-review", visible: true, order: 4 },
        { id: "cycle-summary", visible: false, order: 5 },
        { id: "signals", visible: true, order: 6 },
        { id: "rhythm-events", visible: true, order: 7 },
      ],
      tiles: [{ id: "overview", visible: true, order: 0 }],
    });
    expect(orderedVisibleSectionIds(layout)).toEqual([
      "wellness-scores",
      "vitals",
      "period-review",
      "signals",
      "rhythm-events",
    ]);
  });

  it("honours a reordered section list", () => {
    const layout = resolveInsightsLayout({
      version: 2,
      sections: [
        { id: "trends", visible: true, order: 0 },
        { id: "vitals", visible: true, order: 1 },
        { id: "wellness-scores", visible: true, order: 2 },
      ],
      tiles: [{ id: "overview", visible: true, order: 0 }],
    });
    const visible = orderedVisibleSectionIds(layout);
    // The three explicit sections lead in their saved order; the rest
    // auto-merge invisible (new-id semantics), so they do NOT appear.
    expect(visible.slice(0, 3)).toEqual([
      "trends",
      "vitals",
      "wellness-scores",
    ]);
  });
});

describe("resolveTileLayout — W2c per-tile decision", () => {
  it("returns the saved visible + order for a known tile", () => {
    const layout = resolveInsightsLayout({
      version: 2,
      sections: [{ id: "vitals", visible: true, order: 0 }],
      tiles: [
        { id: "overview", visible: true, order: 0 },
        { id: "hrv", visible: false, order: 1 },
      ],
    });
    expect(resolveTileLayout(layout, "hrv")).toEqual({
      visible: false,
      order: 1,
    });
  });

  it("treats a tile the layout does not enumerate as always-on, ordered last", () => {
    const res = resolveTileLayout(DEFAULT_INSIGHTS_LAYOUT, "not-a-tile");
    expect(res.visible).toBe(true);
    expect(res.order).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps the grid's default vitals tiles visible by default (no regression)", () => {
    for (const id of [
      "weight",
      "bmi",
      "cardio-fitness",
      "vascular-age",
      "hrv",
      "resting-pulse",
      "respiratory-rate",
      "oxygen",
      "body-temperature",
      "blood-glucose",
      "six-minute-walk",
      "stair-ascent-speed",
      "stair-descent-speed",
      "wrist-temperature",
    ]) {
      expect(resolveTileLayout(DEFAULT_INSIGHTS_LAYOUT, id).visible).toBe(true);
    }
  });

  // v1.15.14 — the default is ALL-VISIBLE. The v1.15.11 curated subset
  // dropped ~20 nav pills once the tab strip began gating on the layout
  // (sleep, steps, active-energy, walking-*, audio-*, daylight, the body-
  // composition tiles, …). The grid renders a fixed mapped subset
  // regardless of `tiles.visible`, so all-visible does NOT bloat it; what
  // it restores is the nav's everything-with-data default. Pin it.
  it("defaults EVERY tile visible (nav-pill regression guard)", () => {
    expect(DEFAULT_INSIGHTS_LAYOUT.tiles.length).toBe(INSIGHTS_TILE_IDS.length);
    for (const tile of DEFAULT_INSIGHTS_LAYOUT.tiles) {
      expect(tile.visible).toBe(true);
    }
    // Spot-check the long-tail slugs that previously regressed out of nav.
    for (const id of [
      "sleep",
      "steps",
      "active-energy",
      "walking-distance",
      "walking-speed",
      "flights-climbed",
      "environmental-audio",
      "headphone-audio",
      "daylight",
      "breathing-disturbances",
      "skin-temperature",
      "body-water",
      "fat-mass",
      "muscle-mass",
      "lean-body-mass",
    ]) {
      expect(resolveTileLayout(DEFAULT_INSIGHTS_LAYOUT, id).visible).toBe(true);
    }
  });
});
