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

/**
 * Dashboard widget id → toggleable module key. When the user disables the
 * module, the matching widget is forced invisible on both the web `layout`
 * and the iOS `layoutCatalogue`, so the tile/chart never paints. Only the
 * toggleable surfaces appear here; CORE widgets (weight / bp / pulse /
 * bodyFat / bpInTarget and the vital-derived HealthKit metrics) carry NO
 * entry and are never hidden.
 *
 * v1.18.1 (D3) — `medications` graduated from CORE to a toggleable module,
 * so the medication tile now gates off it like the other toggleable widgets.
 */
export const WIDGET_MODULE_BY_ID: Partial<Record<string, ModuleKey>> = {
  mood: "mood",
  sleep: "sleep",
  glucose: "glucose",
  achievements: "achievements",
  recentWorkouts: "workouts",
  medications: "medications",
  // v1.18.0 B1 — recovery-domain HealthKit widgets belong to the recovery
  // module; the per-night breathing-disturbance widget belongs to sleep.
  cardioRecovery: "recovery",
  sixMinuteWalk: "recovery",
  stairAscentSpeed: "recovery",
  stairDescentSpeed: "recovery",
  breathingDisturbances: "sleep",
  // v1.29 — fluid-intake strip tile, nutrients-store-backed (see
  // `SUMMARY_TYPE_MODULE.NUTRIENT_WATER` below).
  waterIntake: "nutrients",
};

/**
 * Slim-summary keys that belong to a toggleable module. When the module
 * is off the key is stripped from `tiles.summaries` /
 * `tiles.lastSeenByType` (so `metricStates` and the client data-floor
 * gates also drop it) before the snapshot leaves the server. Core vital
 * types are absent here and always pass through.
 *
 * v1.29 — widened from `Partial<Record<MeasurementType, ModuleKey>>` to
 * `Partial<Record<string, ModuleKey>>` so the synthetic `NUTRIENT_WATER`
 * key (a `NutrientIntakeDay`-derived summary, not a real
 * `MeasurementType` — the abandoned `feat/water` branch's parallel
 * `WATER_INTAKE` enum value is deliberately NOT added) can ride the same
 * gate without widening the `MeasurementType` enum itself.
 */
export const SUMMARY_TYPE_MODULE: Partial<Record<string, ModuleKey>> = {
  SLEEP_DURATION: "sleep",
  BLOOD_GLUCOSE: "glucose",
  // v1.18.0 B1 — recovery-domain HealthKit metrics. The recovery page +
  // its tiles are the recovery module's surface; when it is off these
  // device-native signals must drop from the dashboard snapshot too.
  CARDIO_RECOVERY: "recovery",
  SIX_MINUTE_WALK_DISTANCE: "recovery",
  STAIR_ASCENT_SPEED: "recovery",
  STAIR_DESCENT_SPEED: "recovery",
  // The HRV fallback series. `METRIC_STATUS_MODULE_OWNERS` already owns this
  // type for the metric-status / MCP reads, for the reason stated there: a
  // fallback path must not serve the recovery data the primary type refuses.
  // The dashboard snapshot gates off THIS map instead, and the entry was
  // missing — harmless only while the dashboard HRV tile read SDNN alone.
  // Now that the tile falls back to RMSSD (`pickHrvSummary`), the omission
  // would hand a recovery-off account a tile built from recovery-owned rows.
  // `HEART_RATE_VARIABILITY` stays deliberately ungated: SDNN is a plain
  // vital, and it is what the tile shows whenever the account has it.
  HRV_RMSSD: "recovery",
  // Per-night breathing-disturbance index is a sleep-page signal.
  BREATHING_DISTURBANCES: "sleep",
  // v1.29 — fluid-intake dashboard tile summary, derived server-side from
  // `NutrientIntakeDay` (nutrient="water", summed across sources). Gated
  // on the `nutrients` module like the rest of that store's surfaces.
  NUTRIENT_WATER: "nutrients",
  // Mood is a `MoodEntry`-derived summary, not a `MeasurementType`, so it
  // rides the same synthetic-key route as `NUTRIENT_WATER`. Gated on the
  // `mood` module: turning the module off must drop the dashboard card on
  // every client, not just hide the web widget.
  MOOD_ENTRY: "mood",
};

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
