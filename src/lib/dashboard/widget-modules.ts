/**
 * v1.18.0 — client-safe module maps for dashboard widgets / summary types.
 *
 * These two maps are pure data (string → ModuleKey) with no runtime
 * dependency on the DB, Prisma, or the server-only module gate. They are
 * factored out of `@/lib/dashboard/snapshot` so the settings client
 * component (`dashboard-layout-section.tsx`) can import them without
 * dragging the whole server snapshot builder — and its transitive
 * `pg` / `dns` chain — into the browser bundle. `snapshot.ts` re-exports
 * both for the server call sites and the existing tests.
 *
 * `ModuleKey` comes from `@/lib/modules/registry` (pure constants, no
 * imports), so this file stays browser-bundle-safe.
 */
import type { ModuleKey } from "@/lib/modules/registry";
import { isSurfaceVisible, surfaceModulesOfKind } from "@/lib/modules/surface";

/**
 * Dashboard widget id → toggleable module key. A widget whose module is off
 * is forced invisible on both the web `layout` and the iOS
 * `layoutCatalogue`. CORE widgets carry no entry and are never hidden.
 *
 * A view of the one surface map (`widget:*` in `@/lib/modules/surface`), so
 * the dashboard, the Settings list and every other surface answer from the
 * same declaration.
 */
export const WIDGET_MODULE_BY_ID: Partial<Record<string, ModuleKey>> =
  surfaceModulesOfKind("widget");

/**
 * Summary keys that belong to a toggleable module. When the module is off the
 * key is stripped from `tiles.summaries` / `tiles.lastSeenByType` (so
 * `metricStates` and the client data-floor gates drop it too) before the
 * snapshot leaves the server. Core vital types are absent and always pass.
 *
 * Keyed by string rather than `MeasurementType` because two keys are
 * synthetic (`NUTRIENT_WATER`, `MOOD_ENTRY`: day totals derived from other
 * stores). A view of `summary:*` in `@/lib/modules/surface`.
 */
export const SUMMARY_TYPE_MODULE: Partial<Record<string, ModuleKey>> =
  surfaceModulesOfKind("summary");

/**
 * Force every widget whose owning module is off, and every id in `alsoHide`,
 * to invisible (both `visible` and `tileVisible`). Order is kept so a
 * re-enable restores the saved position.
 *
 * A projection for RENDERING only. The stored `dashboardWidgetsJson` is never
 * written through this: `GET /api/dashboard/widgets` returns the stored
 * layout as saved, because Settings edits and re-saves exactly that value,
 * and a masked read saved back would switch the widget off for good. The
 * dashboard snapshot applies it server-side; the dashboard's legacy (no
 * snapshot) path applies it in the browser, so both feeds paint the same.
 */
export function hideModuleWidgets<
  L extends {
    widgets: ReadonlyArray<{
      id: string;
      visible: boolean;
      tileVisible?: boolean;
    }>;
  },
>(
  layout: L,
  modules: Partial<Record<ModuleKey, boolean>> | null | undefined,
  alsoHide: ReadonlySet<string> = new Set(),
): L {
  return {
    ...layout,
    widgets: layout.widgets.map((w) =>
      isSurfaceVisible(`widget:${w.id}`, modules) && !alsoHide.has(w.id)
        ? w
        : { ...w, visible: false, tileVisible: false },
    ),
  };
}

/**
 * The summary types a module map turns off. Lifted out of
 * `gateSummariesByModules` in `@/lib/dashboard/snapshot` so the two
 * dashboard aggregates that both surface per-metric data — the snapshot
 * builder and the iOS `GET /api/dashboard/summary` payload — decide from
 * ONE map instead of each carrying its own copy.
 *
 * The two callers shape their payloads differently (the snapshot keys
 * summaries by `MeasurementType`; the summary route emits an array of
 * metric cards keyed by an iOS `MetricKind`), so what is shared is this
 * decision, not the filtering itself.
 */
export function disabledSummaryTypes(
  modules: Partial<Record<ModuleKey, boolean>>,
): Set<string> {
  const dropped = new Set<string>();
  for (const [type, moduleKey] of Object.entries(SUMMARY_TYPE_MODULE)) {
    if (moduleKey && modules[moduleKey] === false) dropped.add(type);
  }
  return dropped;
}

/**
 * Strip disabled-module types from a summaries slice. Lifted out of
 * `@/lib/dashboard/snapshot`, where it was private, once a second
 * dashboard feed needed it: with `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false`
 * the tile strip hydrates from `/api/analytics` instead of the snapshot,
 * and that route filtered nothing — so a module the user had turned off
 * still reached the client, and the tile it owns still painted. The gate
 * has to sit on every feed that carries summaries, not just the default
 * one, or it is only as strong as a rollout flag.
 *
 * Pure over its inputs and browser-safe (string keys + the map above), so
 * the snapshot builder, the analytics route and any future feed share one
 * implementation rather than each carrying a copy that can drift.
 * Returns shallow copies; the inputs are not mutated.
 */
/**
 * Widget ids whose toggle cannot do anything for THIS account, and so must
 * not be offered at all. `WIDGET_MODULE_BY_ID` above answers the same
 * question for widgets a module owns outright; this answers it for the one
 * widget whose deadness also depends on the account's data.
 *
 * `hrv` is that widget. The tile takes SDNN when the account has it and
 * falls back to nightly RMSSD otherwise (see `pickHrvSummary`). RMSSD is
 * recovery-owned, so with Recovery off it is stripped from every feed —
 * which leaves a ring / strap account, whose only HRV is RMSSD, holding a
 * switch that is on and a tile that can never paint, with nothing saying
 * why. That is precisely the defect the RMSSD fallback exists to remove, so
 * it must not survive one step further on. An account WITH SDNN keeps the
 * row: its tile still works with Recovery off, because SDNN is a plain
 * vital that no module owns.
 *
 * Decided from server-resolved facts and handed to the client, so the
 * Settings screen does not have to fetch dashboard data to find out.
 */
export function unavailableWidgetIds(
  modules: Partial<Record<ModuleKey, boolean>>,
  facts: { hasSdnn: boolean },
): string[] {
  const out: string[] = [];
  if (modules.recovery === false && !facts.hasSdnn) out.push("hrv");
  return out;
}

export function gateSummariesByModules<
  S extends Record<string, unknown>,
  L extends Record<string, unknown>,
>(
  summaries: S,
  lastSeenByType: L,
  modules: Partial<Record<ModuleKey, boolean>>,
): { summaries: S; lastSeenByType: L } {
  const dropped = disabledSummaryTypes(modules);
  if (dropped.size === 0) return { summaries, lastSeenByType };
  const outSummaries = {} as S;
  for (const [type, summary] of Object.entries(summaries)) {
    if (!dropped.has(type))
      (outSummaries as Record<string, unknown>)[type] = summary;
  }
  const outLastSeen = {} as L;
  for (const [type, slot] of Object.entries(lastSeenByType)) {
    if (!dropped.has(type))
      (outLastSeen as Record<string, unknown>)[type] = slot;
  }
  return { summaries: outSummaries, lastSeenByType: outLastSeen };
}

/**
 * iOS `MetricKind` (the `kind` on a `GET /api/dashboard/summary` metric
 * card) → the `MeasurementType` it is built from. The summary route emits
 * cards by kind, but module membership is defined per measurement type in
 * `SUMMARY_TYPE_MODULE` above; this map is the join between the two so the
 * summary payload gates off the SAME source of truth as the snapshot rather
 * than a second, drift-prone kind→module list.
 *
 * Kinds whose type carries no `SUMMARY_TYPE_MODULE` entry (weight, blood
 * pressure, pulse, body fat, steps, body water, bone mass, SpO₂) are core
 * vitals and always pass through — they are listed anyway so a reader can
 * see the full emitted set and so a new card cannot be added without
 * deciding which type backs it.
 */
export const SUMMARY_METRIC_TYPE_BY_KIND: Record<string, string> = {
  weight: "WEIGHT",
  bloodPressure: "BLOOD_PRESSURE_SYS",
  pulse: "PULSE",
  bodyFat: "BODY_FAT",
  glucose: "BLOOD_GLUCOSE",
  sleep: "SLEEP_DURATION",
  steps: "ACTIVITY_STEPS",
  totalBodyWater: "TOTAL_BODY_WATER",
  boneMass: "BONE_MASS",
  oxygenSaturation: "OXYGEN_SATURATION",
  // Synthetic key — see `MOOD_ENTRY` in `SUMMARY_TYPE_MODULE`.
  mood: "MOOD_ENTRY",
  // BMI is derived from weight + the profile height and belongs to no
  // module, exactly like weight and body fat. Listed so the full emitted
  // set stays readable and a future card cannot be added without deciding
  // what backs it.
  bmi: "WEIGHT",
};

/**
 * Drop the metric cards whose backing measurement type belongs to a module
 * the account turned off. A card whose kind is absent from
 * `SUMMARY_METRIC_TYPE_BY_KIND` is kept — an unmapped kind is a core metric
 * or a new one, and silently hiding it would be worse than surfacing it.
 */
export function gateMetricCardsByModules<T extends { kind: string }>(
  cards: ReadonlyArray<T>,
  modules: Partial<Record<ModuleKey, boolean>>,
): T[] {
  const dropped = disabledSummaryTypes(modules);
  if (dropped.size === 0) return [...cards];
  return cards.filter((card) => {
    const type = SUMMARY_METRIC_TYPE_BY_KIND[card.kind];
    return !type || !dropped.has(type);
  });
}

/**
 * Label key for every catalogue widget the WEB does not render.
 *
 * These ids round-trip through `/api/dashboard/widgets` and are drawn by the
 * native client, but `src/app/page.tsx` has no render path for them, so the
 * web Settings list filters them out of its tile/chart rows. That filtering
 * is right — a toggle over a widget this page cannot draw would be a silent
 * no-op — but paired with the native client materialising them into the
 * stored layout it produced a widget nobody could turn off from anywhere
 * (issue #581): the row `{"id":"bmi", …}` was a value the account never set
 * and could not change.
 *
 * So the Settings page surfaces them in a clearly-labelled second group whose
 * copy says these are drawn by the mobile app. Membership is derived from the
 * two id constants in `@/lib/dashboard-layout` rather than repeated here; this
 * map only answers "what do we call it", and a guard test asserts it covers
 * every native-only id so a new one cannot arrive unlabelled.
 */
export const NATIVE_ONLY_WIDGET_LABEL_KEYS: Record<string, string> = {
  // Writable ids (in `DASHBOARD_WIDGET_IDS`) with no web render path.
  cardioRecovery: "measurements.typeCardioRecovery",
  sixMinuteWalk: "measurements.typeSixMinuteWalkDistance",
  stairAscentSpeed: "measurements.typeStairAscentSpeed",
  stairDescentSpeed: "measurements.typeStairDescentSpeed",
  breathingDisturbances: "measurements.typeBreathingDisturbances",
  falls: "measurements.typeFallCount",
  walkingSteadiness: "measurements.typeWalkingSteadiness",
  // Catalogue-only ids the native client materialises in its own layout.
  restingHeartRate: "measurements.typeRestingHeartRate",
  walkingSpeed: "measurements.typeWalkingSpeed",
  walkingAsymmetry: "measurements.typeWalkingAsymmetry",
  walkingStepLength: "measurements.typeWalkingStepLength",
  // BMI is derived from weight + the profile height; the dashboard metric
  // title is the name every other surface already gives it.
  bmi: "dashboard.metric.title.bmi",
  bodyTemperature: "measurements.typeBodyTemperature",
  walkingDoubleSupport: "measurements.typeWalkingDoubleSupport",
  audioExposureEnvironment: "measurements.typeAudioExposureEnv",
  audioExposureHeadphone: "measurements.typeAudioExposureHeadphone",
  gripStrength: "measurements.typeGripStrength",
  painNRS: "measurements.typePainNrs",
  waistCircumference: "measurements.typeWaistCircumference",
  waistToHeight: "measurements.typeWaistToHeight",
};
