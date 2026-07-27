import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_DASHBOARD_LAYOUT,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  DASHBOARD_WIDGET_IDS,
  IOS_PIN_ONLY_WIDGET_IDS,
  buildRingMutationPayload,
  widgetWritesBusy,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { NATIVE_ONLY_WIDGET_LABEL_KEYS } from "@/lib/dashboard/widget-modules";

// v1.11.2 HIGH-1 — the web Settings list renders one row per WRITABLE id
// (`DASHBOARD_WIDGET_IDS`) MINUS the `IOS_PIN_ONLY_WIDGET_IDS` (writable so
// the iOS pin PUT validates, but with no web render path). The default
// layout still carries all 24 writable widgets; only this subset renders.
const WEB_RENDERABLE_ROW_COUNT =
  DASHBOARD_WIDGET_IDS.length - IOS_PIN_ONLY_WIDGET_IDS.length;

// Mutable holder so individual tests can inject a layout (e.g. one that
// carries iOS-only ids) into the mocked `useQuery` without re-mocking
// the module. Defaults to the 16-tile web default layout.
const queryState: { layout: DashboardLayout } = {
  layout: DEFAULT_DASHBOARD_LAYOUT,
};

/**
 * v1.4.15 Fix 5 — independent strip-tile + chart toggles.
 *
 * The settings section grew a SECOND switch column for the upper-row
 * tile, distinct from the existing chart switch. SSR smoke tests are
 * sufficient here; full state-mutation testing would require a DOM
 * runtime which the rest of the settings suite doesn't pull in.
 *
 * v1.4.47 W4 — drag-and-drop reorder via @dnd-kit. The SSR markup picks
 * up the new drag handle, the shared describedby hint paragraph, and
 * keeps the legacy arrow buttons + switches. The reorder contract is
 * exercised via the exported `reorderWidgets` helper so we pin the
 * mutation payload shape without a DOM runtime.
 */

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: queryState.layout, isLoading: false }),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// v1.18.0 — mutable module map so the widget-toggle gating tests can flip a
// module off without re-mocking. Defaults to `undefined` (no map → fail-open,
// every web-renderable row shown), preserving the pre-existing row counts.
const authState: {
  modules: Partial<Record<string, boolean>> | undefined;
} = { modules: undefined };

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { modules: authState.modules } }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  DashboardLayoutSection,
  reorderWidgets,
} from "../dashboard-layout-section";

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

beforeEach(() => {
  queryState.layout = DEFAULT_DASHBOARD_LAYOUT;
  authState.modules = undefined;
});

describe("<DashboardLayoutSection> — tile + chart split", () => {
  it("renders both Tile and Chart column headers in English", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Column headers — the v1.4.15 split.
    expect(html).toContain("Tile");
    expect(html).toContain("Chart");
  });

  it("renders both column headers in German", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />, "de");
    expect(html).toContain("Kachel");
    expect(html).toContain("Chart");
  });

  it("paints both switch slots per widget", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // The two new data-slots distinguish tile vs chart switches in
    // visual-verify and other consumers.
    expect(html).toContain('data-slot="widget-tile-switch"');
    expect(html).toContain('data-slot="widget-chart-switch"');
  });

  it("each widget paints exactly one tile-switch and one chart-switch", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const tileSwitches = html.match(/data-slot="widget-tile-switch"/g) ?? [];
    const chartSwitches = html.match(/data-slot="widget-chart-switch"/g) ?? [];
    // One tile + one chart switch per row: the WEB-renderable widgets in
    // the sortable list, plus the native-only rows below it (issue #581 —
    // the iOS-pin-only ids the default layout carries).
    const nativeRows = (html.match(/data-slot="native-widget-row"/g) ?? [])
      .length;
    expect(nativeRows).toBe(IOS_PIN_ONLY_WIDGET_IDS.length);
    expect(tileSwitches).toHaveLength(WEB_RENDERABLE_ROW_COUNT + nativeRows);
    expect(chartSwitches).toHaveLength(WEB_RENDERABLE_ROW_COUNT + nativeRows);
  });
});

/**
 * v1.4.47 W4 — drag-and-drop reorder surface.
 *
 * The audit (v1.4.43 QoL M1) asked for drag-to-reorder while keeping the
 * arrow-button keyboard fallback. Tests pin (a) the visual surface
 * (drag handle + describedby hint), (b) the keyboard fallback survived,
 * (c) the reorder contract — same `widgets[]` shape with `order: 0..n-1`
 * the existing PUT already accepts.
 */
describe("<DashboardLayoutSection> — drag-and-drop reorder", () => {
  it("paints a drag handle for every widget row", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
  });

  it("each drag handle has an aria-describedby pointing to a shared hint", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Split the markup into per-handle button fragments so we don't need
    // to care about attribute ordering inside the rendered <button>.
    const handleButtons =
      html.match(/<button[^>]*data-slot="widget-drag-handle"[^>]*>/g) ?? [];
    expect(handleButtons).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
    // Every handle declares aria-describedby and they all share the
    // same id (one hint paragraph below the list — single source of
    // truth for screen readers).
    const describedByIds = handleButtons.map((button) => {
      const m = button.match(/aria-describedby="([^"]+)"/);
      expect(m).not.toBeNull();
      return m![1];
    });
    const unique = new Set(describedByIds);
    expect(unique.size).toBe(1);
    const hintId = describedByIds[0];
    // The matching hint paragraph is rendered exactly once.
    expect(html).toMatch(new RegExp(`id="${hintId}"`));
  });

  it("keeps the arrow buttons present after the drag handle lands (a11y fallback)", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Move up + Move down translation keys resolve to the English
    // strings — counted once per row. Both the widget rows and the
    // score-ring reorder rows (health-score anchor + selected rings)
    // carry the same arrow pair, so the total is one per row of either
    // kind.
    const ringRows = (html.match(/data-slot="score-ring-row"/g) ?? []).length;
    const expected = WEB_RENDERABLE_ROW_COUNT + ringRows;
    const moveUpCount = (html.match(/aria-label="Move up"/g) ?? []).length;
    const moveDownCount = (html.match(/aria-label="Move down"/g) ?? []).length;
    expect(moveUpCount).toBe(expected);
    expect(moveDownCount).toBe(expected);
  });

  it("hint string localises to German", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />, "de");
    // v1.4.48 L9 — copy trimmed to ~12 words so screen readers do
    // not spend ~6 s reading the hint on focus. Anchor on the
    // shortened phrase.
    expect(html).toContain("Pfeiltasten Hoch/Runter");
  });
});

describe("reorderWidgets — pure mutation contract", () => {
  // Synthetic small list so the assertions are readable; the helper is
  // shape-only and doesn't care which ids are dashboard widgets.
  const initial = [
    { id: "a", order: 0 },
    { id: "b", order: 1 },
    { id: "c", order: 2 },
    { id: "d", order: 3 },
  ];

  it("moves an item down and rewrites order to 0..n-1", () => {
    const out = reorderWidgets(initial, "a", "c");
    expect(out.map((w) => w.id)).toEqual(["b", "c", "a", "d"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("moves an item up and rewrites order to 0..n-1", () => {
    const out = reorderWidgets(initial, "d", "a");
    expect(out.map((w) => w.id)).toEqual(["d", "a", "b", "c"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("no-op when source equals target", () => {
    const out = reorderWidgets(initial, "b", "b");
    expect(out.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("no-op when an id is missing — still normalises order", () => {
    const out = reorderWidgets(initial, "missing", "a");
    expect(out.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("preserves stable sort by `order` before reordering", () => {
    const shuffled = [
      { id: "c", order: 2 },
      { id: "a", order: 0 },
      { id: "d", order: 3 },
      { id: "b", order: 1 },
    ];
    const out = reorderWidgets(shuffled, "a", "d");
    // Sort first → [a, b, c, d]; move a → d position → [b, c, d, a].
    expect(out.map((w) => w.id)).toEqual(["b", "c", "d", "a"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("returns a fresh array — does not mutate the input", () => {
    const snapshot = JSON.parse(JSON.stringify(initial));
    reorderWidgets(initial, "a", "c");
    expect(initial).toEqual(snapshot);
  });
});

/**
 * v1.7.0 W1 — the stored layout round-trips the iOS-only widget ids. The
 * web tile/chart LIST still has no surface for them (no drag handle, no
 * reorder, no web render path), so the sortable list must skip them.
 *
 * issue #581 — but skipping them everywhere left the account holding rows
 * it never set and could not change from any surface, so they now appear in
 * a separate, clearly-labelled group with their visibility flags.
 */
describe("<DashboardLayoutSection> — iOS-only ids stay out of the web list (v1.7.0)", () => {
  it("keeps iOS-only ids out of the sortable web list", () => {
    // Inject a layout = the web defaults + every catalogue-only iOS id.
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: [
        ...DEFAULT_DASHBOARD_LAYOUT.widgets,
        ...DASHBOARD_IOS_ONLY_WIDGET_IDS.map((id, i) => ({
          id,
          visible: true,
          tileVisible: true,
          order: DEFAULT_DASHBOARD_LAYOUT.widgets.length + i,
        })),
      ],
    };

    const html = render(<DashboardLayoutSection id="dashboard-layout" />);

    // The sortable list is exactly the web-renderable widgets: one drag
    // handle each, and no more.
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);

    // No iOS-only raw id leaks into the markup as a row label — every one
    // of them resolves through a translation key.
    for (const iosId of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(html).not.toContain(`>${iosId}<`);
    }
  });

  it("does not crash when the layout is ENTIRELY iOS-only ids", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: DASHBOARD_IOS_ONLY_WIDGET_IDS.map((id, i) => ({
        id,
        visible: true,
        tileVisible: true,
        order: i,
      })),
    };

    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // No web-renderable rows → no sortable list at all, but the section
    // still renders and every id lands in the native-only group.
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(0);
    const nativeRows = html.match(/data-slot="native-widget-row"/g) ?? [];
    expect(nativeRows).toHaveLength(DASHBOARD_IOS_ONLY_WIDGET_IDS.length);
    expect(html).toContain("dashboard-layout");
  });
});

/**
 * issue #581 — BMI rendered on the native dashboard and was configurable
 * from nowhere: the widgets PUT accepts and persists it, the native client
 * writes it, and the web Settings list filtered it out because the web has
 * no render path for it. The account was left holding
 * `{"id":"bmi","visible":false,…}` — a value it never set and could not
 * change. The native-only group is where those flags become reachable.
 */
describe("<DashboardLayoutSection> — native-only widget group (issue #581)", () => {
  const NATIVE_ONLY_IDS = [
    ...IOS_PIN_ONLY_WIDGET_IDS,
    ...DASHBOARD_IOS_ONLY_WIDGET_IDS,
  ];

  it("offers a tile and a chart switch for BMI when the layout carries it", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: [
        ...DEFAULT_DASHBOARD_LAYOUT.widgets,
        {
          id: "bmi",
          visible: false,
          tileVisible: true,
          order: DEFAULT_DASHBOARD_LAYOUT.widgets.length,
        },
      ],
    };

    const html = render(<DashboardLayoutSection id="dashboard-layout" />);

    expect(html).toContain('data-widget-id="bmi"');
    expect(html).toContain('aria-label="BMI — Tile"');
    expect(html).toContain('aria-label="BMI — Chart"');
    // Reflects the stored flags rather than inventing a default.
    const row = html.match(
      /data-widget-id="bmi"[\s\S]*?(?=data-slot="native-widget-row"|$)/,
    )![0];
    expect(row).toContain('data-slot="widget-tile-switch"');
    expect(row).toContain('data-slot="widget-chart-switch"');
    // ...and it is NOT in the sortable web list (no drag handle for it).
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
  });

  it("labels the group and says which client draws these widgets", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: [
        ...DEFAULT_DASHBOARD_LAYOUT.widgets,
        { id: "bmi", visible: false, tileVisible: true, order: 99 },
      ],
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(html).toContain('data-slot="native-only-widgets"');
    expect(html).toContain("Shown in the mobile app");
    expect(html).toContain("The mobile app draws these");
  });

  it("shows nothing when the layout holds no native-only id", () => {
    // The stock web default layout carries the pin-only writable ids but
    // no catalogue-only ones; strip both so a pure web account is modelled.
    const nativeOnly = new Set<string>(NATIVE_ONLY_IDS);
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets.filter(
        (w) => !nativeOnly.has(w.id),
      ),
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(html).not.toContain('data-slot="native-only-widgets"');
    expect(html).not.toContain("Shown in the mobile app");
  });

  it("every native-only id has a label key, so no row can render raw", () => {
    for (const id of NATIVE_ONLY_IDS) {
      expect(
        NATIVE_ONLY_WIDGET_LABEL_KEYS[id],
        `${id} has no label key — its row would render its raw id`,
      ).toBeTruthy();
    }
  });

  it("hides a native-only row whose owning module is off", () => {
    authState.modules = { recovery: false };
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: [
        ...DEFAULT_DASHBOARD_LAYOUT.widgets,
        { id: "bmi", visible: false, tileVisible: true, order: 99 },
      ],
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // `cardioRecovery` belongs to the recovery module and drops out; BMI
    // belongs to none and stays.
    expect(html).not.toContain('data-widget-id="cardioRecovery"');
    expect(html).toContain('data-widget-id="bmi"');
    authState.modules = undefined;
  });
});

/**
 * v1.11.2 HIGH-1 — the 8 B5 ids are WRITABLE (in DASHBOARD_WIDGET_IDS so the
 * iOS pin PUT validates them) but have NO web render path, so the web
 * Settings list must NOT offer a dead toggle for them.
 */
describe("<DashboardLayoutSection> — iOS-pin-only ids hidden from web (v1.11.2)", () => {
  it("renders one fewer sortable row per iOS-pin-only id than the writable id count", () => {
    // Default layout carries all writable widgets incl. the pin-only ones.
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
    // Sanity: WEB_RENDERABLE_ROW_COUNT == writable − pin-only.
    expect(WEB_RENDERABLE_ROW_COUNT).toBe(
      DASHBOARD_WIDGET_IDS.length - IOS_PIN_ONLY_WIDGET_IDS.length,
    );
  });

  it("paints the pin-only labels ONLY in the native-only group", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // The pin-only ids reuse `measurements.type*` labels that resolve to
    // distinctive English strings; none should appear as a toggle aria-label.
    const pinOnlyLabels: Record<
      (typeof IOS_PIN_ONLY_WIDGET_IDS)[number],
      string
    > = {
      cardioRecovery: "Cardio recovery",
      sixMinuteWalk: "Six-minute walk distance",
      stairAscentSpeed: "Stair ascent speed",
      stairDescentSpeed: "Stair descent speed",
      breathingDisturbances: "Breathing disturbances",
      // v1.28.52 — `wristTemperature` is no longer pin-only; it now renders
      // a web row, so it left both IOS_PIN_ONLY_WIDGET_IDS and this map.
      falls: "Falls",
      walkingSteadiness: "Walking steadiness",
    };
    // The sortable web list must not offer them (issue #581 note: the
    // native-only group below it does, which is where the markup match
    // now comes from — so anchor on the sortable rows themselves).
    const sortableList = html.slice(
      0,
      html.indexOf('data-slot="native-only-widgets"'),
    );
    for (const id of IOS_PIN_ONLY_WIDGET_IDS) {
      expect(sortableList).not.toContain(`${pinOnlyLabels[id]} — `);
      // ...and each is reachable exactly once, in the native-only group.
      expect(html).toContain(`data-widget-id="${id}"`);
    }
  });
});

/**
 * v1.18.0 — a dashboard widget toggle whose owning module is disabled is a
 * dead control: the snapshot gates the tile/chart out server-side no matter
 * what the switch says. The Settings list must hide those rows. Core widgets
 * (no module entry in `WIDGET_MODULE_BY_ID`) always show; the gate fails open
 * when the module map is absent or the key is unset.
 */
describe("<DashboardLayoutSection> — disabled-module widget toggles", () => {
  // The achievements widget label drives its switch aria-label; it is the
  // canonical disabled-module probe (label resolves to "Achievements").
  const ACHIEVEMENTS_ARIA = "Achievements — ";
  // Mood is a module-owned widget too; weight is a core widget with NO module
  // entry, so it must survive any module-off state.
  const MOOD_ARIA = "Mood — ";
  const WEIGHT_ARIA = "Weight — ";

  it("hides a widget toggle whose owning module is disabled", () => {
    authState.modules = { achievements: false };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // The achievements row (and its switches) are gone…
    expect(html).not.toContain(ACHIEVEMENTS_ARIA);
    // …and exactly one fewer sortable row renders.
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT - 1);
  });

  it("keeps an enabled-module widget and core (no-module) widgets shown", () => {
    authState.modules = { achievements: false };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Enabled module (mood) still renders…
    expect(html).toContain(MOOD_ARIA);
    // …and a core widget with no module entry (weight) always shows.
    expect(html).toContain(WEIGHT_ARIA);
  });

  it("shows every row when the module map is absent (fail-open)", () => {
    authState.modules = undefined;
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
    expect(html).toContain(ACHIEVEMENTS_ARIA);
  });
});

/**
 * v1.27.7 — hero score-ring picker. Renders whenever the layout loads
 * (it configures the server-computed score rings the dashboard snapshot
 * carries); offers only rings whose owning module is enabled; caps the
 * selection at three via disabled switches. SSR smoke assertions,
 * matching the rest of this suite.
 */
describe("<DashboardLayoutSection> — hero score-ring picker (v1.27.7)", () => {
  it("renders for the default layout", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(html).toContain('data-slot="score-rings-picker"');
  });

  it("renders one switch per ring (fail-open module map)", () => {
    queryState.layout = DEFAULT_DASHBOARD_LAYOUT;
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(html).toContain('data-slot="score-rings-picker"');
    // v1.27.27 — one switch per score ring (4) plus the always-present
    // health-score anchor row = 5.
    const switches = html.match(/data-slot="score-ring-switch"/g) ?? [];
    expect(switches).toHaveLength(5);
    // The default selection (MED_COMPLIANCE) reads checked.
    const compliance = html.match(
      /<button[^>]*data-slot="score-ring-switch"[^>]*data-ring="MED_COMPLIANCE"[^>]*>/,
    );
    expect(compliance).not.toBeNull();
    expect(compliance![0]).toContain('data-state="checked"');
  });

  it("hides rings whose owning module is disabled (anchor stays)", () => {
    queryState.layout = DEFAULT_DASHBOARD_LAYOUT;
    authState.modules = { recovery: false, sleep: false };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const switches = html.match(/data-slot="score-ring-switch"/g) ?? [];
    // READINESS + RECOVERY_SCORE (recovery) and SLEEP_SCORE (sleep) are
    // gone; the adherence ring plus the health-score anchor remain = 2.
    expect(switches).toHaveLength(2);
    expect(html).toContain('data-ring="MED_COMPLIANCE"');
    expect(html).toContain('data-ring="HEALTH_SCORE"');
  });

  it("hides the derived rings when the insights module is off (anchor stays)", () => {
    queryState.layout = DEFAULT_DASHBOARD_LAYOUT;
    authState.modules = { insights: false };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const switches = html.match(/data-slot="score-ring-switch"/g) ?? [];
    // Adherence ring + health-score anchor.
    expect(switches).toHaveLength(2);
    expect(html).toContain('data-ring="MED_COMPLIANCE"');
  });

  it("disables the remaining switches at the three-ring cap", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      selectedScoreRings: ["READINESS", "RECOVERY_SCORE", "SLEEP_SCORE"],
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const compliance = html.match(
      /<button[^>]*data-slot="score-ring-switch"[^>]*data-ring="MED_COMPLIANCE"[^>]*>/,
    );
    expect(compliance).not.toBeNull();
    // The rendered `disabled` HTML attribute — not the Tailwind
    // `disabled:` variant prefixes that every switch class list carries.
    expect(compliance![0]).toContain('disabled=""');
    // The three selected rings stay enabled (unchecking must stay possible).
    const readiness = html.match(
      /<button[^>]*data-slot="score-ring-switch"[^>]*data-ring="READINESS"[^>]*>/,
    );
    expect(readiness).not.toBeNull();
    expect(readiness![0]).not.toContain('disabled=""');
  });
});

/**
 * v1.27.27 — the health-score ring is a first-class, always-present,
 * reorderable member of the hero ring row. The picker renders it as a
 * pinned row (no on/off toggle — a disabled, checked switch) that leads by
 * default and reorders with the same drag-handle + arrow-button pair as the
 * score rings and the widget list.
 */
describe("<DashboardLayoutSection> — health-score anchor + reorder (v1.27.27)", () => {
  it("renders the health-score anchor as a reorderable row, leading by default", () => {
    queryState.layout = DEFAULT_DASHBOARD_LAYOUT;
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // A sortable ring row exists for the health-score anchor.
    expect(html).toContain('data-slot="score-ring-row"');
    const anchorRow = html.match(
      /<div[^>]*data-slot="score-ring-row"[^>]*data-ring="HEALTH_SCORE"[^>]*>/,
    );
    expect(anchorRow).not.toBeNull();
    // Default order leads with the anchor: its row precedes the adherence
    // ring's row.
    const anchorIdx = html.indexOf('data-ring="HEALTH_SCORE"');
    const medIdx = html.indexOf(
      'data-slot="score-ring-row" data-ring="MED_COMPLIANCE"',
    );
    expect(anchorIdx).toBeGreaterThan(-1);
    // The anchor row appears before any selected score-ring row.
    expect(anchorIdx).toBeLessThan(html.indexOf('data-ring="MED_COMPLIANCE"'));
    expect(medIdx === -1 || anchorIdx < medIdx).toBe(true);
  });

  it("the anchor switch is checked and disabled (locked-on, no toggle-off)", () => {
    queryState.layout = DEFAULT_DASHBOARD_LAYOUT;
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const anchorSwitch = html.match(
      /<button[^>]*data-slot="score-ring-switch"[^>]*data-ring="HEALTH_SCORE"[^>]*>/,
    );
    expect(anchorSwitch).not.toBeNull();
    expect(anchorSwitch![0]).toContain('data-state="checked"');
    expect(anchorSwitch![0]).toContain('disabled=""');
  });

  it("the anchor carries a drag handle + move arrows (reorderable)", () => {
    queryState.layout = DEFAULT_DASHBOARD_LAYOUT;
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // The health-score row is a full sortable row: its drag handle exists.
    const handles = html.match(/data-slot="score-ring-drag-handle"/g) ?? [];
    // One handle per hero-order row = anchor + default MED_COMPLIANCE = 2.
    expect(handles.length).toBeGreaterThanOrEqual(2);
  });

  it("honours a persisted order that moves the anchor off the lead", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      selectedScoreRings: ["READINESS", "MED_COMPLIANCE"],
      heroRingOrder: ["READINESS", "HEALTH_SCORE", "MED_COMPLIANCE"],
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const readinessRow = html.indexOf(
      'data-slot="score-ring-row" data-ring="READINESS"',
    );
    const anchorRow = html.indexOf(
      'data-slot="score-ring-row" data-ring="HEALTH_SCORE"',
    );
    const medRow = html.indexOf(
      'data-slot="score-ring-row" data-ring="MED_COMPLIANCE"',
    );
    expect(readinessRow).toBeGreaterThan(-1);
    expect(anchorRow).toBeGreaterThan(readinessRow);
    expect(medRow).toBeGreaterThan(anchorRow);
  });

  it("the ring mutation PUTs both selectedScoreRings and heroRingOrder (source pin)", () => {
    const src = readFileSync(
      join(
        process.cwd(),
        "src/components/settings/dashboard-layout-section.tsx",
      ),
      "utf8",
    );
    expect(src).toContain("selectedScoreRings: next.selectedScoreRings");
    expect(src).toContain("heroRingOrder: next.heroRingOrder");
    // The order is the single source of truth: selection is derived from it.
    expect(src).toMatch(/id !== HEALTH_SCORE_RING_ID/);
  });

  it("the ring mutation builds its body via buildRingMutationPayload, not a `...remote` spread (regression #581 source pin)", () => {
    const src = readFileSync(
      join(
        process.cwd(),
        "src/components/settings/dashboard-layout-section.tsx",
      ),
      "utf8",
    );
    // v1.32.16 — the ring body is built via `buildRingMutationPayload`,
    // now also threading the optimistic-concurrency base token.
    expect(src).toContain("buildRingMutationPayload({ ...next, baseUpdatedAt");
    // The pre-fix shape must never come back: spreading a query-cache
    // snapshot into the ring PUT body is exactly the stale-`widgets`
    // race issue #581 reported.
    expect(src).not.toMatch(/\.\.\.remote,/);
  });
});

/**
 * v1.32.16 (issue #581) — a committed Save must stay authoritative against a
 * concurrent instant hero-ring write. The full DOM interaction (fire a ring
 * write, then a Save, assert the disabled/pending gate) can't run under this
 * suite's SSR-only convention, so the load-bearing client contract is pinned
 * as pure exported units plus source pins for the wiring the JSX depends on.
 */
describe("dashboard layout — Save cannot be clobbered by a ring write (#581)", () => {
  it("buildRingMutationPayload never carries widgets and threads the base token", () => {
    const payload = buildRingMutationPayload({
      selectedScoreRings: ["READINESS"],
      heroRingOrder: ["HEALTH_SCORE", "READINESS"],
      baseUpdatedAt: "2026-07-24T10:00:00.000Z",
    });
    // None of the fields a stale snapshot could carry and use to overwrite
    // a fresher Save.
    expect(payload).not.toHaveProperty("widgets");
    expect(payload).not.toHaveProperty("comparisonBaseline");
    expect(payload).not.toHaveProperty("chartOverlayPrefs");
    // The ring selection + the guard token DO ride.
    expect(payload.selectedScoreRings).toEqual(["READINESS"]);
    expect(payload.baseUpdatedAt).toBe("2026-07-24T10:00:00.000Z");
  });

  it("buildRingMutationPayload omits the base-token key when none is known", () => {
    const payload = buildRingMutationPayload({
      selectedScoreRings: [],
      heroRingOrder: ["HEALTH_SCORE"],
    });
    expect(payload).not.toHaveProperty("baseUpdatedAt");
  });

  it("widgetWritesBusy gates off EITHER write being in flight", () => {
    expect(widgetWritesBusy(false, false)).toBe(false);
    expect(widgetWritesBusy(true, false)).toBe(true); // Save pending
    expect(widgetWritesBusy(false, true)).toBe(true); // ring pending
    expect(widgetWritesBusy(true, true)).toBe(true);
  });

  it("the Save + ring controls bind the shared busy gate and serialise via one scope (source pin)", () => {
    const src = readFileSync(
      join(
        process.cwd(),
        "src/components/settings/dashboard-layout-section.tsx",
      ),
      "utf8",
    );
    // Save button + ring controls both read `widgetWritesBusy(...)` so the
    // gate is one source of truth — the button can never disable on
    // `saveMutation.isPending` alone (the pre-fix hole).
    expect(src).toContain("widgetWritesBusy(");
    // Both writes share a mutation scope so they run serially at the client.
    expect(src).toContain("scope: { id: DASHBOARD_WIDGETS_MUTATION_SCOPE }");
    // Each write sends the optimistic-concurrency base token.
    expect(src).toContain("baseUpdatedAt: readBaseToken()");
    // A 409 is handled (refetch + gentle nudge), not swallowed as a hard error.
    expect(src).toContain("err.status === 409");
  });
});
