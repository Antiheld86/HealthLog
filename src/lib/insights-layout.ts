/**
 * Insights tile layout — persisted in `User.insightsLayoutJson`.
 *
 * Single source of truth for which insights pills show on `/insights`,
 * what order they render in, and what the default layout is for new
 * users. Null / missing column = default layout below; the GET endpoint
 * never lazy-writes a row, so the column only carries data once the
 * user has explicitly saved a layout.
 *
 * Mirrors `dashboard-layout.ts` for the dashboard widget surface — same
 * resolver / serializer semantics, same auto-merge of new tile IDs
 * introduced in later releases. Keeping the two modules structurally
 * identical means the iOS client + the Settings UI can share rendering
 * code paths against either surface.
 */

import { SUB_PAGE_SLUGS } from "@/lib/insights/sub-page-metric";

/**
 * Every insights tile the layout knows about. The mother-page overview
 * is keyed `"overview"`; every other id is a routed sub-page slug under
 * `/insights/<slug>`. The order of entries here is irrelevant —
 * `DEFAULT_INSIGHTS_LAYOUT.tiles[].order` drives the visual order.
 * Exported so the API Zod `tileIdEnum` can be built from a single
 * source of truth.
 *
 * v1.8.7.1 — the tile-id universe is derived FROM `SUB_PAGE_SLUGS`
 * (`src/lib/insights/sub-page-metric.ts`), the same record the routed
 * tab strip and the per-metric sub-pages enumerate. The two surfaces
 * therefore stay in lockstep by construction: adding a sub-page slug
 * automatically widens the layout enum, and the iOS client can persist
 * a layout covering the full metric set (blood-pressure … skin-
 * temperature) rather than tripping a 422 on the ~25 slugs the layout
 * previously did not know about. `"overview"` is layout-only — it is
 * the mother page, not a sub-page slug — so it is prepended explicitly.
 *
 * v1.8.0 — the canonical ids are English, matching the routed slugs
 * (`/insights/<slug>`) and the naming-convention ADR
 * (`docs/adr/0001-insights-naming-convention.md`). The ids were German
 * through v1.7.x and the iOS layout-sync contract
 * (`GET/PUT /api/insights/layout`) speaks them, so the layout endpoint
 * keeps ACCEPTING the legacy German ids and NORMALISES them to the
 * canonical English ones on both read and write — see
 * `LEGACY_INSIGHTS_TILE_ID_ALIASES` + `normalizeInsightsTileId` below.
 * No client breaks; iOS migrates to the English ids at its own pace.
 */
export const INSIGHTS_TILE_IDS = ["overview", ...SUB_PAGE_SLUGS] as const;

export type InsightsTileId = (typeof INSIGHTS_TILE_IDS)[number];

/**
 * Legacy (≤ v1.7.x) German tile ids mapped to their canonical English
 * replacement. The layout endpoint accepts these as input so the iOS
 * client's stored layouts keep round-tripping after the v1.8.0 rename;
 * every write path normalises them away before persisting (see
 * `normalizeInsightsTileId`). `bmi`, `hrv`, `workouts`, and `overview`
 * were already language-neutral and need no alias.
 */
export const LEGACY_INSIGHTS_TILE_ID_ALIASES: Record<string, InsightsTileId> = {
  blutdruck: "blood-pressure",
  puls: "pulse",
  sauerstoff: "oxygen",
  koerpertemperatur: "body-temperature",
  gewicht: "weight",
  "aktive-energie": "active-energy",
  schlaf: "sleep",
  ruhepuls: "resting-pulse",
  stimmung: "mood",
  medikamente: "medications",
};

/**
 * Every id the layout endpoint accepts on input — canonical English
 * plus the legacy German aliases. The Zod `tileIdEnum` is built from
 * this union so a PUT carrying old ids passes validation rather than
 * tripping a 422; `normalizeInsightsTileId` collapses the union back to
 * the canonical id before anything persists.
 */
export const ACCEPTED_INSIGHTS_TILE_IDS = [
  ...INSIGHTS_TILE_IDS,
  ...Object.keys(LEGACY_INSIGHTS_TILE_ID_ALIASES),
] as const;

/**
 * Collapse a legacy German tile id onto its canonical English id.
 * Canonical ids (and unknown ids) pass through unchanged — the
 * resolver's known-id filter drops anything truly unrecognised.
 */
export function normalizeInsightsTileId(id: string): string {
  return Object.hasOwn(LEGACY_INSIGHTS_TILE_ID_ALIASES, id)
    ? LEGACY_INSIGHTS_TILE_ID_ALIASES[id]
    : id;
}

/**
 * v1.15.11 — the overview's big semantic blocks, customizable at the
 * section level on top of the per-metric `tiles` list. Order here is the
 * default render order (Hero is NOT a section — Hero + Score + Coach
 * stays an anchored, non-customizable top block above the customizable
 * region). English from birth — unlike the tile ids these never had a
 * German phase, so no alias map is needed.
 *
 * Maps to the `/insights` page blocks: WellnessScores → `wellness-scores`,
 * DailyBriefing → `daily-briefing`, VitalsDashboard → `vitals`, TrendsRow
 * → `trends`, PeriodNarrativeCard → `period-review`, CycleInsightSummary
 * → `cycle-summary`, CoincidentDeviationCard → `signals`, RhythmEvents →
 * `rhythm-events`.
 */
export const INSIGHTS_SECTION_IDS = [
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
  // v1.28.50 — ECG recording surface (waveform-backed, single-lead device).
  // Kept separate from the waveform-less `rhythm-events` timeline. Auto-merges
  // default-invisible onto existing saved layouts (per the section resolver),
  // default-visible for new users; data-availability-gated on top.
  "ecg",
] as const;

export type InsightsSectionId = (typeof INSIGHTS_SECTION_IDS)[number];

export interface InsightsSectionConfig {
  id: InsightsSectionId;
  visible: boolean;
  order: number;
}

export interface InsightsTileConfig {
  id: InsightsTileId;
  visible: boolean;
  order: number;
}

export interface InsightsLayout {
  version: number;
  sections: InsightsSectionConfig[];
  tiles: InsightsTileConfig[];
}

/**
 * v1.32.21 (R5a) — the resolved layout plus the server-stamped `updatedAt`
 * optimistic-concurrency token (mirrors `User.updatedAt`, never persisted
 * inside the blob). GET and every write response carry it; the client echoes
 * it back as `baseUpdatedAt` on the next write. Mirrors
 * `DashboardLayoutWithToken`.
 */
export type InsightsLayoutWithToken = InsightsLayout & {
  updatedAt?: string;
};

const INSIGHTS_LAYOUT_VERSION = 2;

/**
 * Default layout mirrors the routed tab-strip order — vitals first,
 * then body composition, activity, sleep, cardiovascular, mood, then
 * events. Every tile ships default-VISIBLE; the user hides what they
 * don't want. Adding a new tile lands as an additional default-visible
 * row here and the resolver auto-merges it onto existing users' saved
 * layouts.
 *
 * v1.15.14 — the default is now ALL-VISIBLE. The v1.15.11 design shipped
 * a curated subset (`DEFAULT_VISIBLE_TILE_IDS`) authored for the overview
 * Vitals/Mobility GRID, which renders only a FIXED mapped set of tiles
 * (the four derived re-frames + `SECTION_VITALS` + `SECTION_MOBILITY` —
 * see `vitals-dashboard.tsx`). But once the tab strip began gating its
 * nav pills on the same layout (v1.15.14 W2), that curated subset dropped
 * ~20 nav pills for a fresh account with data in Sleep, Steps,
 * Active-Energy, body composition, Walking/mobility, Audio, Daylight,
 * etc. — pills that show today — and caused a "pills flash in then
 * vanish" once the layout GET settled.
 *
 * The grid renders a fixed mapped subset regardless of `tiles.visible`
 * (the long-tail slugs never appear in the grid), so defaulting EVERY
 * tile visible does NOT bloat the grid — it stays its curated, data-gated
 * set. What it restores is the tab strip's everything-with-data default:
 * a fresh account sees every pill it has data for, and the user hides the
 * ones they don't want. Data availability stays the floor everywhere — a
 * visible tile with no readings still renders nothing.
 */
export const DEFAULT_INSIGHTS_LAYOUT: InsightsLayout = {
  version: INSIGHTS_LAYOUT_VERSION,
  // Every section ships default-visible; feature/data gates still apply
  // on top at render time. The dense 0-based `order` follows
  // `INSIGHTS_SECTION_IDS`, which mirrors the current page render order.
  sections: INSIGHTS_SECTION_IDS.map((id, order) => ({
    id,
    visible: true,
    order,
  })),
  // Order follows `INSIGHTS_TILE_IDS` (overview first, then the
  // `SUB_PAGE_SLUGS` order, which itself tracks the MeasurementCategory
  // overlay: vitals → body → activity → sleep → cardiovascular → mood →
  // events). The dense 0-based `order` mirrors the routed tab strip.
  // Every tile defaults VISIBLE — see the module note above for why the
  // v1.15.11 curated subset was a nav-pill regression.
  tiles: INSIGHTS_TILE_IDS.map((id, order) => ({
    id,
    visible: true,
    order,
  })),
};

export function resolveInsightsLayout(raw: unknown): InsightsLayout {
  if (!raw || typeof raw !== "object") return DEFAULT_INSIGHTS_LAYOUT;
  const candidate = raw as Partial<InsightsLayout>;
  if (
    typeof candidate.version !== "number" ||
    !Array.isArray(candidate.tiles)
  ) {
    return DEFAULT_INSIGHTS_LAYOUT;
  }

  // v1.8.0 — normalise legacy German tile ids onto their canonical
  // English replacement BEFORE the known-id filter so a layout persisted
  // by a ≤ v1.7.x client (or the iOS app still speaking the old ids)
  // survives the read instead of being silently dropped as "unknown".
  // Dedupe afterwards: a layout carrying both the legacy and the
  // canonical id (e.g. a partial migration) keeps the first occurrence
  // so the round-trip stays idempotent.
  const knownIds = new Set<string>(INSIGHTS_TILE_IDS);
  const seen = new Set<string>();
  const filtered: InsightsTileConfig[] = candidate.tiles
    .map((t) => ({ ...t, id: normalizeInsightsTileId(t.id) }))
    .filter((t): t is InsightsTileConfig => {
      if (!knownIds.has(t.id) || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

  // Merge with defaults so new tiles introduced in later versions show
  // up automatically. v1.22 — appended tiles inherit the default's
  // visibility (`visible: true` for every default tile) instead of being
  // force-hidden. The old default-invisible override silently dropped the
  // pill for any late-added tile id (e.g. `steps`, which entered the set in
  // v1.12) on every read of an existing or iOS-synced layout that didn't
  // enumerate it, so it never matched the fresh-account default. The
  // per-tile data floor (`summaries[...].count > 0` at the call site) still
  // keeps an empty metric from bloating the nav.
  const savedIds = new Set(filtered.map((t) => t.id));
  const missing = DEFAULT_INSIGHTS_LAYOUT.tiles.filter(
    (t) => !savedIds.has(t.id),
  );
  const maxOrder = Math.max(0, ...filtered.map((t) => t.order));
  const appended = missing.map((t, i) => ({
    ...t,
    order: maxOrder + 1 + i,
  }));

  return {
    version: INSIGHTS_LAYOUT_VERSION,
    sections: resolveInsightsSections(candidate.sections),
    tiles: [...filtered, ...appended].sort((a, b) => a.order - b.order),
  };
}

/**
 * v1.15.11 — section-level resolution, mirroring the tile semantics:
 * filter unknown ids, dedupe (first occurrence wins), merge missing
 * default sections, sort by order. A v1 blob (no `sections` key) — or
 * any garbage `sections` value — yields the full default section set, all
 * default-visible, so existing iOS-written layouts resolve forward to a
 * valid v2 layout untouched. New section ids introduced in a later
 * release auto-merge default-INVISIBLE onto a saved layout (same as
 * tiles); the current 8 sections come from the defaults default-visible
 * whenever the blob omits them.
 */
function resolveInsightsSections(raw: unknown): InsightsSectionConfig[] {
  if (!Array.isArray(raw)) {
    // Missing / garbage → full default set, all visible.
    return DEFAULT_INSIGHTS_LAYOUT.sections.map((s) => ({ ...s }));
  }

  const knownIds = new Set<string>(INSIGHTS_SECTION_IDS);
  const seen = new Set<string>();
  const filtered: InsightsSectionConfig[] = (
    raw as Array<Partial<InsightsSectionConfig>>
  )
    .filter((s): s is InsightsSectionConfig => {
      if (
        !s ||
        typeof s.id !== "string" ||
        typeof s.visible !== "boolean" ||
        typeof s.order !== "number"
      ) {
        return false;
      }
      if (!knownIds.has(s.id) || seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    })
    .map((s) => ({ id: s.id, visible: s.visible, order: s.order }));

  const savedIds = new Set(filtered.map((s) => s.id));
  const missing = DEFAULT_INSIGHTS_LAYOUT.sections.filter(
    (s) => !savedIds.has(s.id),
  );
  const maxOrder = Math.max(0, ...filtered.map((s) => s.order));
  const appended = missing.map((s, i) => ({
    ...s,
    visible: false, // default-invisible on auto-upgrade of a NEW section id
    order: maxOrder + 1 + i,
  }));

  return [...filtered, ...appended].sort((a, b) => a.order - b.order);
}

/**
 * Input shape for {@link serializeInsightsLayout}. Looser than
 * {@link InsightsLayout}: the tile `id` is a bare `string` so the PUT
 * handler can hand a Zod-parsed body that still carries legacy German
 * aliases — `serializeInsightsLayout` normalises them onto canonical
 * {@link InsightsTileId} values on the way through.
 */
export interface InsightsLayoutInput {
  version: number;
  sections?: Array<{ id: string; visible: boolean; order: number }>;
  tiles?: Array<{ id: string; visible: boolean; order: number }>;
}

export function serializeInsightsLayout(
  layout: InsightsLayoutInput,
  previous?: InsightsLayout,
): InsightsLayout {
  // v1.16.13 — a PUT that omits a dimension must KEEP the user's stored
  // value for it, not reset it to defaults. iOS reorders tiles with a
  // tiles-only PUT (no `sections` key); without the stored fallback that
  // PUT silently wipes the user's section customization (and vice-versa
  // for a section-only PUT against stored tiles). When no stored layout
  // is supplied we still fall back to defaults so a first-ever PUT on a
  // single dimension persists a complete blob.
  // v1.8.0 — normalise legacy German tile ids onto canonical English
  // before persisting so the stored blob is always canonical even when
  // the PUT body carried the old ids (the Zod enum accepts both via
  // `ACCEPTED_INSIGHTS_TILE_IDS`). Dedupe so a body sending both the
  // legacy and canonical id for one tile collapses to a single entry,
  // keeping the dense 0-based order contiguous.
  const seen = new Set<string>();
  // An omitted `tiles` (a section-only PUT) keeps the stored tiles when
  // available, else falls back to the canonical default tile set so the
  // persisted blob is always complete.
  if (!layout.tiles) {
    return {
      version: INSIGHTS_LAYOUT_VERSION,
      sections: serializeInsightsSections(layout.sections, previous),
      tiles: (previous?.tiles ?? DEFAULT_INSIGHTS_LAYOUT.tiles).map((t) => ({
        ...t,
      })),
    };
  }
  return {
    version: INSIGHTS_LAYOUT_VERSION,
    sections: serializeInsightsSections(layout.sections, previous),
    tiles: layout.tiles
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((t) => ({ ...t, id: normalizeInsightsTileId(t.id) }))
      .filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      })
      .map((t, i) => ({
        id: t.id as InsightsTileId,
        visible: t.visible,
        order: i, // normalize to 0-based dense order
      })),
  };
}

/**
 * v1.15.11 — normalise an optional `sections` input: drop unknown ids,
 * dedupe (first occurrence by order wins), re-number to a dense 0-based
 * order. If the input omits `sections` entirely, keep the user's stored
 * sections when supplied (v1.16.13 — a tiles-only PUT must not wipe the
 * section customization), else fill from defaults so a first-ever
 * tiles-only PUT still persists a valid v2 blob.
 */
function serializeInsightsSections(
  sections: InsightsLayoutInput["sections"],
  previous?: InsightsLayout,
): InsightsSectionConfig[] {
  if (!sections) {
    return (previous?.sections ?? DEFAULT_INSIGHTS_LAYOUT.sections).map(
      (s) => ({
        ...s,
      }),
    );
  }

  const knownIds = new Set<string>(INSIGHTS_SECTION_IDS);
  const seen = new Set<string>();
  return sections
    .slice()
    .sort((a, b) => a.order - b.order)
    .filter((s) => {
      if (!knownIds.has(s.id) || seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    })
    .map((s, i) => ({
      id: s.id as InsightsSectionId,
      visible: s.visible,
      order: i, // normalize to 0-based dense order
    }));
}

/**
 * v1.15.11 W2 — the visible section ids in render order, derived from a
 * resolved layout. Pure helper so the page can map each id onto its JSX in
 * `SECTION_REGISTRY` without re-implementing the sort/filter inline (and so
 * the ordering is unit-testable without rendering React). Sections marked
 * `visible: false` are dropped; the rest sort by `order`. Feature/data gates
 * still apply on top at render time — a gated-off section that is
 * layout-visible still renders nothing (its component self-gates / returns
 * null), so this list is the *candidate* order, not a render guarantee.
 */
export function orderedVisibleSectionIds(
  layout: InsightsLayout,
): InsightsSectionId[] {
  return layout.sections
    .filter((s) => s.visible)
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => s.id);
}

/**
 * v1.15.11 W2c — resolve a single tile's layout decision against a resolved
 * layout. Returns `{ visible, order }` for a known tile id; for a tile id the
 * layout does not enumerate (a dashboard tile with no corresponding layout
 * entry — e.g. a derived re-frame like FITNESS_AGE) the tile is treated as
 * always-on and sorted last so it never disappears on the user. Data-gating
 * still applies on top — a `visible: true` tile with no data renders nothing.
 */
export function resolveTileLayout(
  layout: InsightsLayout,
  tileId: InsightsTileId | string,
): { visible: boolean; order: number } {
  const entry = layout.tiles.find((t) => t.id === tileId);
  if (entry) return { visible: entry.visible, order: entry.order };
  // Unknown-to-layout tile → always render, ordered after every known tile.
  return { visible: true, order: Number.MAX_SAFE_INTEGER };
}
