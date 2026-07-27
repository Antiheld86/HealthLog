"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
  LayoutDashboard,
  RotateCcw,
  Loader2,
  ArrowUp,
  ArrowDown,
  GripVertical,
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Switch } from "@/components/ui/switch";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  type DashboardLayout,
  type DashboardWidgetId,
  type ComparisonBaseline,
  type ScoreRingId,
  type HeroRingId,
  COMPARISON_BASELINES,
  DEFAULT_DASHBOARD_LAYOUT,
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  IOS_PIN_ONLY_WIDGET_IDS,
  type DashboardWidgetCatalogueId,
  SCORE_RING_IDS,
  SCORE_RING_MODULE,
  MAX_SELECTED_SCORE_RINGS,
  HEALTH_SCORE_RING_ID,
  resolveHeroRingOrder,
  buildRingMutationPayload,
  widgetWritesBusy,
  type DashboardLayoutWithToken,
} from "@/lib/dashboard-layout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiDelete, apiGet, apiPut, ApiError } from "@/lib/api/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import {
  NATIVE_ONLY_WIDGET_LABEL_KEYS,
  WIDGET_MODULE_BY_ID,
} from "@/lib/dashboard/widget-modules";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";

/**
 * v1.4.47 W4 — pure reorder helper shared by the arrow buttons and the
 * @dnd-kit drag-end handler. Both surfaces produce the same `widgets[]`
 * shape (`order: 0..n-1`) so the existing PUT contract stays untouched
 * and either input mode flushes via the same Save mutation. Exported so
 * the unit test can pin the contract without spinning up a DndContext.
 *
 * v1.4.48 M6a — also drives the arrow-button `move()` handler below;
 * the previous in-file swap-and-renumber implementation was a second
 * copy of the same logic.
 */
export function reorderWidgets(
  widgets: readonly { id: string; order: number }[],
  fromId: string,
  toId: string,
): { id: string; order: number }[] {
  const sorted = [...widgets].sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((w) => w.id === fromId);
  const toIdx = sorted.findIndex((w) => w.id === toId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) {
    return sorted.map((w, i) => ({ ...w, order: i }));
  }
  const next = [...sorted];
  const [removed] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, removed);
  return next.map((w, i) => ({ ...w, order: i }));
}

/**
 * v1.4.48 M6a — merge the `{ id, order }` shape returned by
 * `reorderWidgets()` back into the full `DashboardWidgetConfig[]` so
 * the section's draft state keeps every per-row flag (`visible`,
 * `tileVisible`) while the order is rewritten. The arrow buttons and
 * the @dnd-kit drag-end handler both flow through this helper so
 * neither surface can silently drop a flag.
 */
function mergeReorderIntoLayout(
  widgets: DashboardLayout["widgets"],
  reordered: readonly { id: string; order: number }[],
): DashboardLayout["widgets"] {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  return reordered.map((r, i) => {
    const original = byId.get(r.id as DashboardWidgetId);
    if (!original) {
      // v1.4.49 — defence-in-depth dev warning for the orphan branch.
      // Today this branch is statically unreachable: every id in
      // `reordered` is sourced from `layout.widgets`, so `byId.get`
      // always hits. The upcoming per-tile Suspense refactor will
      // introduce dynamic widgets where this invariant could break;
      // the warning fires in dev only so a regression surfaces in the
      // console instead of silently dropping the row via the cast.
      if (
        typeof window !== "undefined" &&
        process.env.NODE_ENV === "development"
      ) {
        console.warn(
          `mergeReorderIntoLayout: orphan widget id "${r.id}" dropped`,
        );
      }
      return { ...r, order: i } as never;
    }
    return { ...original, order: i };
  });
}

/**
 * v1.32.16 (issue #581) — the normal layout Save and the instant hero-ring
 * PUT both write the whole `/api/dashboard/widgets` layout. Sharing one
 * TanStack mutation `scope` serialises them: a second write in this scope
 * waits for the first to settle, so the two PUTs can never overlap at the
 * server and a committed Save cannot be reverted by a ring write that
 * started from the pre-Save snapshot.
 */
const DASHBOARD_WIDGETS_MUTATION_SCOPE = "dashboard-widgets" as const;

const WIDGET_LABEL_KEYS: Record<DashboardWidgetId, string> = {
  weight: "dashboard.weight",
  bp: "dashboard.bloodPressure",
  pulse: "dashboard.pulse",
  bodyFat: "dashboard.bodyFat",
  mood: "dashboard.mood",
  medications: "dashboard.medications",
  sleep: "measurements.typeSleep",
  steps: "measurements.typeSteps",
  glucose: "measurements.typeBloodGlucose",
  totalBodyWater: "measurements.typeTotalBodyWater",
  boneMass: "measurements.typeBoneMass",
  // v1.28.52 — muscle mass joins the body-composition strip tiles.
  muscleMass: "measurements.typeMuscleMass",
  bpInTarget: "dashboard.bpInTarget",
  oxygenSaturation: "measurements.typeOxygenSaturation",
  // v1.28.52 — HRV + respiratory rate graduate to web-writable widgets.
  hrv: "measurements.typeHeartRateVariability",
  respiratoryRate: "measurements.typeRespiratoryRate",
  achievements: "achievements.title",
  // v1.4.25 W8d — VO2 max secondary-metric tile (opt-in).
  vo2Max: "dashboard.vo2Max",
  // v1.4.32 — Recent workouts tile (default-on).
  recentWorkouts: "dashboard.recentWorkouts.title",
  // v1.11.2 B5 — v1.10 additive HealthKit signals, now pinnable. Each
  // reuses the existing measurement-type label key.
  cardioRecovery: "measurements.typeCardioRecovery",
  sixMinuteWalk: "measurements.typeSixMinuteWalkDistance",
  stairAscentSpeed: "measurements.typeStairAscentSpeed",
  stairDescentSpeed: "measurements.typeStairDescentSpeed",
  breathingDisturbances: "measurements.typeBreathingDisturbances",
  wristTemperature: "measurements.typeWristTemperature",
  falls: "measurements.typeFallCount",
  walkingSteadiness: "measurements.typeWalkingSteadiness",
  // v1.18.2 — Vorsorge preventive-care summary card.
  vorsorge: "measurementReminders.sectionTitle",
  // v1.29 — fluid intake strip tile (nutrients-store-backed).
  waterIntake: "nutrients.names.water",
};

/**
 * v1.27.7 — option labels for the hero score-ring picker. The three
 * derived rings reuse their wellness-strip titles; the dose ring names
 * today's tally (the exact thing the ring shows since it moved off the
 * 7-day adherence percentage).
 */
const SCORE_RING_LABEL_KEYS: Record<ScoreRingId, string> = {
  READINESS: "insights.derived.composite.READINESS.title",
  RECOVERY_SCORE: "insights.derived.scores.recovery",
  SLEEP_SCORE: "insights.derived.composite.SLEEP_SCORE.title",
  MED_COMPLIANCE: "dashboard.hero.ringDoses",
};

/**
 * v1.27.27 — label key for any hero ring id, including the always-present
 * health-score anchor ring. Reuses the hero's own "Health Score" label so
 * the picker row and the hero ring name match verbatim.
 */
const HERO_RING_LABEL_KEYS: Record<HeroRingId, string> = {
  [HEALTH_SCORE_RING_ID]: "dashboard.hero.scoreLabel",
  ...SCORE_RING_LABEL_KEYS,
};

export function DashboardLayoutSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  // v1.18.0 — a widget toggle whose owning module is disabled is a dead
  // control (the snapshot gates the tile/chart out server-side regardless
  // of the switch). Read the resolved module map and hide those rows.
  // Fail-open: a missing map / absent key (stale /me payload, core widget)
  // reads as enabled, so the row always shows unless the module is
  // explicitly `false`.
  const { user } = useAuth();
  const modules = user?.modules;
  // v1.4.47 W4 — stable id namespace for the drag-handle `aria-describedby`
  // tooltip. One hint paragraph is rendered once at the bottom of the list
  // and referenced by every drag handle in this section.
  const dragHintId = useId();

  // v1.4.47 W4 — sensors: pointer for mouse/touch, keyboard for Tab + Space
  // + arrow-key reordering. The KeyboardSensor still works for users who
  // tab to the GripVertical handle; the legacy ArrowUp / ArrowDown buttons
  // below remain the primary keyboard surface for accessibility.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Activation distance avoids the drag stealing every click on the row
      // switches — only a 6 px pointer-down → move counts as drag intent.
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const { data: remote, isLoading } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async () => {
      return apiGet<DashboardLayoutWithToken>("/api/dashboard/widgets");
    },
    // v1.32.19 (B-3, belt for the #581 fix) — the home RSC seeds
    // `dashboardWidgets()` from the dashboard SNAPSHOT layout, which carries
    // NO `updatedAt` optimistic-concurrency token (it is a token-less
    // `DashboardLayout`, not the `DashboardLayoutWithToken` this section's GET
    // returns). Within the global 5-min `staleTime` a visit to `/` then Settings
    // read that seeded token-less value with no mount refetch, so `readBaseToken()`
    // returned undefined, the Save sent no `baseUpdatedAt`, and the route's
    // compat fallback silently reverted to last-write-wins — disabling the
    // just-shipped 409 belt. Force a mount refetch so this section always holds
    // its own tokened GET response and every write carries the base token. The
    // smallest correct option: the alternatives (a distinct seed key, or
    // threading the token through the snapshot layout) touch the home client and
    // the server snapshot shape; this is one line, config-independent, and makes
    // the settings query authoritative for its own tokened read.
    refetchOnMount: "always",
  });

  /**
   * v1.32.16 (issue #581) — the freshest optimistic-concurrency token the
   * client knows. Read straight from the widgets query cache at mutate time
   * (not a render snapshot) so it reflects whatever the last settled write
   * or refetch advanced it to. Every write sends it as `baseUpdatedAt`.
   */
  const readBaseToken = () =>
    queryClient.getQueryData<DashboardLayoutWithToken>(
      queryKeys.dashboardWidgets(),
    )?.updatedAt;

  // Local draft state — null means "use server copy". User edits create the
  // draft so reordering/toggling doesn't fire a network call per click; Save
  // flushes it, Cancel clears it. Avoids a setState-in-effect (eslint
  // react-hooks/set-state-in-effect is strict in this repo).
  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  const layout = draft ?? remote ?? null;

  const saveMutation = useMutation({
    // v1.32.16 (issue #581) — shared scope serialises this against the
    // instant ring PUT so they can never overlap at the server.
    scope: { id: DASHBOARD_WIDGETS_MUTATION_SCOPE },
    mutationFn: async (next: DashboardLayout) => {
      return apiPut<DashboardLayoutWithToken>("/api/dashboard/widgets", {
        ...next,
        // Guard the write on the token this edit was based on.
        baseUpdatedAt: readBaseToken(),
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.dashboardWidgets(), saved);
      // v1.18.10 — the Startseite reads its layout (tile/chart visibility,
      // order, comparison baseline, hero toggle) from the dashboard
      // SNAPSHOT, not from this `dashboardWidgets` key. Without an
      // invalidation the snapshot keeps its cached layout and the dashboard
      // looks stale until a manual reload. Invalidate the snapshot so the
      // next visit (or open tab) re-reads the saved layout immediately.
      //
      // `refetchType: "all"` is load-bearing: while the user sits on this
      // settings page the dashboard is UNMOUNTED, so its snapshot cell is
      // inactive — the default `refetchType: "active"` only marks it stale,
      // and the snapshot query's deliberate `refetchOnMount: false`
      // (use-dashboard-snapshot.ts) then suppresses the mount-time refetch
      // on a same-tab navigation back to `/`. The saved tile selection only
      // surfaced on the 120 s poll or a window-focus flick ("saved but the
      // dashboard shows old tiles"). Refetching ALL matching cells fires the
      // request right here, so the dashboard mounts onto fresh data.
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboardSnapshot(),
        refetchType: "all",
      });
      setDraft(null);
      toast.success(t("dashboard.layoutSaveSuccess"));
    },
    onError: (err) => {
      // v1.32.16 (issue #581) — a 409 means someone else (another tab, or
      // an interleaved ring write) committed since this edit was based.
      // Refetch the winning layout so the base token advances, KEEP the
      // draft so the user can re-apply, and nudge gently instead of a hard
      // error — nothing was lost, the change just needs re-saving.
      if (err instanceof ApiError && err.status === 409) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.dashboardWidgets(),
        });
        toast.message(t("dashboard.layoutConflictReloaded"));
        return;
      }
      toast.error(t("dashboard.layoutSaveError"));
    },
  });

  const resetMutation = useMutation({
    // v1.32.16 — same scope so a reset can't race the layout / ring writes.
    scope: { id: DASHBOARD_WIDGETS_MUTATION_SCOPE },
    mutationFn: async () => {
      return apiDelete<DashboardLayoutWithToken>("/api/dashboard/widgets");
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.dashboardWidgets(), saved);
      // v1.18.10 — same snapshot invalidation as the save path so a reset
      // to defaults reflects on the Startseite without a manual reload.
      // `refetchType: "all"` for the same reason as the save path: the
      // unmounted snapshot cell must refetch NOW, not on its next poll.
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboardSnapshot(),
        refetchType: "all",
      });
      setDraft(null);
      toast.success(t("dashboard.layoutResetSuccess"));
    },
  });

  function toggle(widgetId: DashboardWidgetCatalogueId, visible: boolean) {
    if (!layout) return;
    setDraft({
      ...layout,
      widgets: layout.widgets.map((w) =>
        w.id === widgetId ? { ...w, visible } : w,
      ),
    });
  }

  /**
   * v1.4.15 Fix 5 — independent toggle for the *strip tile* (the upper
   * row of trend cards). Until v1.4.14 a single switch controlled both
   * the tile AND the chart for the same metric, which the maintainer found too
   * coarse: they wanted a chart visible without the tile (for metrics they
   * tracks without wanting the at-a-glance number) or vice versa.
   */
  function toggleTile(
    widgetId: DashboardWidgetCatalogueId,
    tileVisible: boolean,
  ) {
    if (!layout) return;
    setDraft({
      ...layout,
      widgets: layout.widgets.map((w) =>
        w.id === widgetId ? { ...w, tileVisible } : w,
      ),
    });
  }

  /**
   * v1.4.16 phase B8 — comparison baseline picker. The toggle persists
   * via the same `/api/dashboard/widgets` PUT the existing layout
   * controls already use; saving rides through the same `Save` button.
   */
  function setComparisonBaseline(value: ComparisonBaseline) {
    if (!layout) return;
    setDraft({ ...layout, comparisonBaseline: value });
  }

  /**
   * v1.27.8 — the ring choices apply INSTANTLY, outside the draft/Save
   * machine the rest of the section keeps. The first cut routed ring
   * toggles through the draft, and the combination of an unflushed
   * draft, the server snapshot cache, and client staleness read as
   * "flipping does nothing, rings appear later". The mutation
   * optimistically updates the widgets query and invalidates the
   * dashboard snapshot on settle so the hero reflects the choice on the
   * next visit.
   *
   * v1.32.1 — the PUT body used to be the FULL server layout copy,
   * spreading this component's `remote` query-cache snapshot in ahead of
   * the two ring fields. That snapshot can be stale by the time the
   * request actually lands: if the normal
   * tile/chart Save button committed a newer layout first, this
   * request's explicit — present, not omitted — stale `widgets` (and
   * `comparisonBaseline` / `chartOverlayPrefs`) still won on write and
   * silently reverted the just-saved layout (issue #581). The payload
   * now carries ONLY the ring fields; the server's preserve-when-absent
   * merge (`LAYOUT_FIELD_MERGE_DISPOSITION` — `widgets` joined it in the
   * same release) carries every omitted field forward from whatever is
   * CURRENTLY stored, so this request can no longer race a concurrent
   * Save no matter which one lands last.
   */
  const ringMutation = useMutation({
    // v1.32.16 (issue #581) — shared scope serialises this against the full
    // layout Save so the two writes can never overlap at the server.
    scope: { id: DASHBOARD_WIDGETS_MUTATION_SCOPE },
    mutationFn: async (next: {
      selectedScoreRings: ScoreRingId[];
      heroRingOrder: HeroRingId[];
    }) => {
      return apiPut<DashboardLayoutWithToken>(
        "/api/dashboard/widgets",
        // Carries ONLY the ring fields (never `widgets`) plus the base
        // token, so it can neither clobber a saved layout nor win a stale
        // race — a conflict 409s instead.
        buildRingMutationPayload({ ...next, baseUpdatedAt: readBaseToken() }),
      );
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.dashboardWidgets(),
      });
      const previous = queryClient.getQueryData<DashboardLayout>(
        queryKeys.dashboardWidgets(),
      );
      if (previous) {
        queryClient.setQueryData(queryKeys.dashboardWidgets(), {
          ...previous,
          selectedScoreRings: next.selectedScoreRings,
          heroRingOrder: next.heroRingOrder,
        });
      }
      return { previous };
    },
    onError: (err, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          queryKeys.dashboardWidgets(),
          context.previous,
        );
      }
      // v1.32.16 (issue #581) — a 409 means a concurrent write landed
      // first. Roll back the optimistic ring change (above), refetch the
      // winning layout so the token advances, drop this now-stale delta,
      // and nudge gently so the user can re-toggle against fresh state.
      if (err instanceof ApiError && err.status === 409) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.dashboardWidgets(),
        });
        toast.message(t("dashboard.layoutConflictReloaded"));
        return;
      }
      toast.error(t("dashboard.layoutSaveError"));
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.dashboardWidgets(), saved);
      // `refetchType: "all"` for the same reason as the save path: the
      // unmounted snapshot cell must refetch NOW, not on its next poll.
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboardSnapshot(),
        refetchType: "all",
      });
    },
  });

  /**
   * v1.27.27 — apply a new hero ring ORDER instantly (see `ringMutation`).
   * The order is the single source of truth: `selectedScoreRings` is
   * derived from it (order minus the always-present health-score ring) so
   * the server resolver and the hero read one consistent sequence.
   */
  function applyHeroRingOrder(next: HeroRingId[]) {
    // v1.32.16 (issue #581) — gate on the freshest layout (`draft ?? remote`)
    // the rest of the section uses, not the `remote` server snapshot alone,
    // so an open draft's edits stay the source of truth.
    if (!layout) return;
    const selectedScoreRings = next.filter(
      (id): id is ScoreRingId => id !== HEALTH_SCORE_RING_ID,
    );
    // Keep an open draft's ring slice in sync so a later Save of the
    // OTHER layout edits can't revert the instantly-applied choice.
    if (draft) setDraft({ ...draft, selectedScoreRings, heroRingOrder: next });
    ringMutation.mutate({ selectedScoreRings, heroRingOrder: next });
  }

  /** The reconciled hero ring order (health-score anchor + selected rings). */
  function currentHeroOrder(l: DashboardLayout): HeroRingId[] {
    return resolveHeroRingOrder(l.heroRingOrder, l.selectedScoreRings ?? []);
  }

  /**
   * v1.27.7 — toggle one hero score ring on/off. Enabling appends to the
   * order (capped at `MAX_SELECTED_SCORE_RINGS`; the remaining switches
   * disable at the cap); disabling drops it from the order. The
   * health-score ring has no toggle — it is the always-present anchor.
   * v1.27.8 / v1.27.27 — applies instantly via `applyHeroRingOrder`.
   */
  function toggleScoreRing(ringId: ScoreRingId, enabled: boolean) {
    if (!layout) return;
    const order = currentHeroOrder(layout);
    if (enabled) {
      if (order.includes(ringId)) return;
      const selectedCount = order.filter(
        (id) => id !== HEALTH_SCORE_RING_ID,
      ).length;
      if (selectedCount >= MAX_SELECTED_SCORE_RINGS) return;
      applyHeroRingOrder([...order, ringId]);
    } else {
      applyHeroRingOrder(order.filter((id) => id !== ringId));
    }
  }

  /**
   * v1.27.8 / v1.27.27 — reorder the hero rings (the array order IS the
   * render order on the hero; the health-score anchor moves like any other
   * ring). Same interaction pair as the widget rows below: drag handle +
   * arrow buttons.
   */
  function moveHeroRing(ringId: HeroRingId, delta: -1 | 1) {
    if (!layout) return;
    const order = currentHeroOrder(layout);
    const idx = order.indexOf(ringId);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    [next[idx], next[target]] = [next[target], next[idx]];
    applyHeroRingOrder(next);
  }

  function handleRingDragEnd(event: DragEndEvent) {
    if (!layout) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const order = currentHeroOrder(layout);
    const from = order.indexOf(active.id as HeroRingId);
    const to = order.indexOf(over.id as HeroRingId);
    if (from < 0 || to < 0) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    applyHeroRingOrder(next);
  }

  /**
   * v1.4.48 M6a — the arrow buttons now delegate to `reorderWidgets()`
   * so the swap-and-renumber logic lives in exactly one place. The
   * neighbour id is derived from the sorted layout index + delta;
   * out-of-bounds clicks (top row + ArrowUp, bottom row + ArrowDown)
   * short-circuit before the helper sees them so the button disabled
   * state stays the single source of truth for the boundary.
   */
  function move(widgetId: DashboardWidgetId, delta: -1 | 1) {
    if (!layout) return;
    const sorted = [...layout.widgets].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((w) => w.id === widgetId);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= sorted.length) return;
    const neighbourId = sorted[targetIdx].id;
    const reordered = reorderWidgets(layout.widgets, widgetId, neighbourId);
    setDraft({
      ...layout,
      widgets: mergeReorderIntoLayout(layout.widgets, reordered),
    });
  }

  /**
   * v1.4.47 W4 — drag-and-drop reorder via @dnd-kit. Persists the same
   * `order` rewrite shape the arrow buttons already use, so save / cancel
   * / reset and the existing draft state machine work unchanged. The
   * pointer + keyboard sensors are wired in the same `useSensors` call;
   * keyboard a11y still also works through the legacy arrow buttons that
   * remain on every row.
   */
  function handleDragEnd(event: DragEndEvent) {
    if (!layout) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const reordered = reorderWidgets(
      layout.widgets,
      String(active.id),
      String(over.id),
    );
    setDraft({
      ...layout,
      widgets: mergeReorderIntoLayout(layout.widgets, reordered),
    });
  }

  // Presence of a draft implies dirty — no JSON comparison needed.
  const dirty = draft !== null && layout !== null;

  return (
    <SettingsCard id={id} className="scroll-mt-28 space-y-4">
      {/* v1.4.19 A6 — title / action row uses the same stack-on-mobile,
          right-align-on-desktop contract as Account → Password +
          Restart onboarding tour. Avoids the long German "Auf Standard
          zurücksetzen" copy clipping the card edge at narrow widths. */}
      <SettingsCardHeader
        icon={LayoutDashboard}
        title={t("dashboard.customizeTitle")}
        status={
          <ConfirmButton
            slot="settings-dashboard-layout-reset"
            variant="ghost"
            size="sm"
            className="min-h-11 self-end sm:min-h-9 sm:self-auto"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            label={t("dashboard.layoutReset")}
            title={t("dashboard.layoutResetTitle")}
            body={t("dashboard.layoutResetBody")}
            confirmLabel={t("dashboard.layoutResetConfirm")}
            pending={resetMutation.isPending}
            onConfirm={() => resetMutation.mutate()}
          />
        }
      />
      {/*
        v1.4.22 D / F-32 — the surrounding `<DashboardSection>` page
        already renders a `settings.sections.dashboard.description`
        paragraph beneath the H1. The previous in-card help line
        repeated the same idea ("Choose which cards appear …
        Defaults work out of the box.") right next to the comparison
        picker, giving the page three muted-foreground help blocks
        stacked on top of each other. Removing this duplicate keeps
        the comparison picker as the only thing between the header
        and the widget table.
      */}

      {/* v1.4.16 phase B8 — comparison baseline picker. Lives at the top
          of the section because it changes how every chart + tile below
          renders, not just one. v1.4.19 A6: height standardised to the
          shared 36-px input contract used by every other Settings input
          / select; the previous `min-h-11` (44 px) made this trigger
          look like an outlier next to the 36-px Username/Email/Date-of-
          birth fields one card up. */}
      {layout && (
        <div className="space-y-2">
          <label
            htmlFor="comparison-baseline"
            className="text-foreground text-sm font-medium"
          >
            {t("comparison.toggleLabel")}
          </label>
          <Select
            value={layout.comparisonBaseline ?? "none"}
            onValueChange={(value) =>
              setComparisonBaseline(value as ComparisonBaseline)
            }
            disabled={saveMutation.isPending}
          >
            <SelectTrigger
              id="comparison-baseline"
              className="w-full sm:w-72"
              data-slot="comparison-baseline-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPARISON_BASELINES.map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  data-slot={`comparison-baseline-option-${value}`}
                >
                  {t(`comparison.baseline.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {t("comparison.toggleHint")}
          </p>
        </div>
      )}

      {/* v1.27.7 — hero score-ring picker. Configures the score rings the
          server computes onto the dashboard snapshot (`selectedScoreRings`
          / `heroRingOrder`), consumed by the native client. Offers only
          rings whose owning module is enabled — the WIDGET_MODULE_BY_ID
          gating pattern; the three derived rings additionally sit behind
          the insights module, mirroring the derived routes. Selection caps
          at MAX_SELECTED_SCORE_RINGS; unchecked switches disable at the cap.
          v1.27.8 — choices apply instantly (no Save round) and the
          selected rings reorder with the same drag-handle + arrow pair
          as the widget rows below; the array order is the ring order. */}
      {layout && (
        <div
          data-slot="score-rings-picker"
          className="border-border bg-background/30 space-y-3 rounded-md border px-3 py-2"
        >
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">
              {t("dashboard.scoreRingsTitle")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("dashboard.scoreRingsDescription")}
            </p>
          </div>
          {(() => {
            const available = SCORE_RING_IDS.filter((ringId) => {
              if (modules?.[SCORE_RING_MODULE[ringId]] === false) return false;
              if (ringId !== "MED_COMPLIANCE" && modules?.insights === false)
                return false;
              return true;
            });
            const selected = (layout.selectedScoreRings ?? []).filter(
              (ringId) => available.includes(ringId),
            );
            // v1.27.27 — the reorderable list is the health-score anchor
            // ring plus the selected score rings, in the persisted order
            // (health-score first by default). The health-score row has no
            // on/off switch — it is always present — but drags/moves like
            // any other ring.
            const heroOrder = resolveHeroRingOrder(
              layout.heroRingOrder,
              selected,
            );
            const unselected = available.filter(
              (ringId) => !heroOrder.includes(ringId),
            );
            const atCap = selected.length >= MAX_SELECTED_SCORE_RINGS;
            // v1.32.16 (issue #581) — ring controls also lock while a Save
            // is in flight, so the two writes can never overlap.
            const busy = widgetWritesBusy(
              saveMutation.isPending,
              ringMutation.isPending,
            );
            return (
              <div className="space-y-2">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleRingDragEnd}
                >
                  <SortableContext
                    items={heroOrder}
                    strategy={verticalListSortingStrategy}
                  >
                    {heroOrder.map((ringId, index) => (
                      <SortableRingRow
                        key={ringId}
                        ringId={ringId}
                        label={t(HERO_RING_LABEL_KEYS[ringId])}
                        index={index}
                        total={heroOrder.length}
                        dragHintId={dragHintId}
                        disabled={busy}
                        // The health-score ring is the anchor — no toggle.
                        pinned={ringId === HEALTH_SCORE_RING_ID}
                        moveUpLabel={t("dashboard.moveUp")}
                        moveDownLabel={t("dashboard.moveDown")}
                        dragHandleLabel={t("dashboard.dragHandle")}
                        onToggle={toggleScoreRing}
                        onMove={moveHeroRing}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
                {unselected.map((ringId) => (
                  <div
                    key={ringId}
                    className="flex min-h-9 items-center justify-between gap-3 px-1"
                  >
                    <span className="text-foreground truncate text-sm">
                      {t(SCORE_RING_LABEL_KEYS[ringId])}
                    </span>
                    <Switch
                      checked={false}
                      onCheckedChange={(v) => toggleScoreRing(ringId, v)}
                      disabled={busy || atCap}
                      aria-label={t(SCORE_RING_LABEL_KEYS[ringId])}
                      data-slot="score-ring-switch"
                      data-ring={ringId}
                    />
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {isLoading || !layout ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          {t("common.loading")}
        </div>
      ) : (
        // `relative` anchors the sr-only drag-hint paragraph below: Tailwind's
        // `sr-only` is `position: absolute`, and without a positioned ancestor
        // its containing block is the initial containing block — the 1px box
        // then sits at its static position (below this long list) in DOCUMENT
        // coordinates and silently makes the document itself scrollable, a
        // second vertical scrollbar next to the shell-owned `<main>` scroll
        // (UI-STANDARDS §9 one-scroll-floor; guarded by
        // e2e/settings-overscroll.spec.ts).
        <div className="relative space-y-2">
          {/* v1.4.15 Fix 5 — table-style header naming the two
              switches. The "tile" column controls the strip tile in
              the upper row; the "chart" column controls the line
              chart in the lower row. the maintainer wanted independent control
              of the two surfaces (per feedback_dashboard_top_tiles
              _selectable.md). */}
          {/* v1.4.29 — column-header alignment for the new
              horizontal arrow pair on the trailing edge. The
              right-hand spacer reserves the width of two
              size-11/sm:size-9 buttons so the Tile / Chart column
              headers continue to line up with the switches below. */}
          {/* v1.4.47 W4 — column header spacer additionally reserves the
              width of the new drag-handle icon (w-7) so Tile / Chart
              alignment with the row switches below stays pixel-perfect. */}
          <div className="text-muted-foreground flex items-center gap-2 px-3 pb-1 text-xs font-medium tracking-wide uppercase">
            <span className="w-7" aria-hidden="true" />
            <span className="flex-1" aria-hidden="true" />
            <span className="w-12 text-center">
              {t("dashboard.layoutTileColumn")}
            </span>
            <span className="w-12 text-center">
              {t("dashboard.layoutChartColumn")}
            </span>
            <span className="w-22 sm:w-18" aria-hidden="true" />
          </div>
          {(() => {
            // v1.7.0 — the stored layout now round-trips the 11 iOS-only
            // widget ids so the native client can drop its local merge
            // workarounds. The web Settings list has no tile/chart
            // surface for them, so skip any id outside the web-known
            // ids rather than render an unlabelled row with dead toggles.
            // The skipped ids stay untouched in the persisted layout
            // because the Save mutation PUTs `layout.widgets` whole and
            // the server retains every catalogue id.
            //
            // v1.11.2 HIGH-1 — the 8 B5 ids are WRITABLE (in
            // `DASHBOARD_WIDGET_IDS` so the iOS pin PUT validates) but
            // have no web render path either, so exclude
            // `IOS_PIN_ONLY_WIDGET_IDS` too: a web toggle for them would
            // be a silent no-op on the web dashboard.
            const iosPinOnly = new Set<string>(IOS_PIN_ONLY_WIDGET_IDS);
            const webWidgetIds = new Set<string>(
              DASHBOARD_WIDGET_IDS.filter((wid) => !iosPinOnly.has(wid)),
            );
            const sortedWidgets = [...layout.widgets]
              .filter((w): w is typeof w & { id: DashboardWidgetId } =>
                webWidgetIds.has(w.id),
              )
              // v1.18.0 — hide a widget toggle whose owning module is
              // disabled. Map the widget id → ModuleKey FIRST (undefined =
              // core widget = always shown), THEN check the module map.
              // Fail-open: only an explicit `false` hides the row.
              .filter((w) => {
                const moduleKey = WIDGET_MODULE_BY_ID[w.id];
                return !moduleKey || modules?.[moduleKey] !== false;
              })
              .sort((a, b) => a.order - b.order);
            const sortedIds = sortedWidgets.map((w) => w.id);
            return (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={sortedIds}
                  strategy={verticalListSortingStrategy}
                >
                  {sortedWidgets.map((widget, index, arr) => (
                    <SortableWidgetRow
                      key={widget.id}
                      widget={widget}
                      labelKey={WIDGET_LABEL_KEYS[widget.id] ?? widget.id}
                      index={index}
                      total={arr.length}
                      dragHintId={dragHintId}
                      disabled={saveMutation.isPending}
                      labels={{
                        tileColumn: t("dashboard.layoutTileColumn"),
                        chartColumn: t("dashboard.layoutChartColumn"),
                        moveUp: t("dashboard.moveUp"),
                        moveDown: t("dashboard.moveDown"),
                        dragHandle: t("dashboard.dragHandle"),
                        widgetLabel: t(
                          WIDGET_LABEL_KEYS[widget.id] ?? widget.id,
                        ),
                      }}
                      onToggleTile={toggleTile}
                      onToggleChart={toggle}
                      onMove={move}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            );
          })()}
          {/* v1.4.47 W4 — single shared aria-describedby target for all
              drag handles. Screen readers read this once per focused
              handle; sighted users see it in the native browser tooltip
              via the matching `title` attribute on each handle.
              v1.4.48 L8 — gate on widget count so an empty layout never
              orphans the paragraph (no handles to describe). */}
          {layout.widgets.length > 0 && (
            <p id={dragHintId} className="text-muted-foreground sr-only">
              {t("dashboard.dragHandleHint")}
            </p>
          )}

          {/* issue #581 — widgets the mobile app draws and this page does
              not. Filtering them out of the list above is right (a toggle
              over something the web cannot draw would be a silent no-op),
              but the native client materialises them into the SAME stored
              layout, so the account ended up holding rows it never set and
              could not change from anywhere. They get their own labelled
              group: the same two flags, no reordering (placement is the
              native client's), and only for ids the layout actually holds —
              an account with no native client has nothing to configure here
              and sees nothing. */}
          {(() => {
            const nativeOnlyIds = new Set<string>([
              ...IOS_PIN_ONLY_WIDGET_IDS,
              ...DASHBOARD_IOS_ONLY_WIDGET_IDS,
            ]);
            const nativeWidgets = layout.widgets
              .filter((w) => nativeOnlyIds.has(w.id))
              // Same fail-open module gate as the web list: only an explicit
              // `false` hides the row.
              .filter((w) => {
                const moduleKey = WIDGET_MODULE_BY_ID[w.id];
                return !moduleKey || modules?.[moduleKey] !== false;
              })
              .sort((a, b) => a.order - b.order);
            if (nativeWidgets.length === 0) return null;
            return (
              <div
                data-slot="native-only-widgets"
                className="border-border/60 mt-6 space-y-2 border-t pt-4"
              >
                <p className="text-sm font-medium">
                  {t("dashboard.layoutNativeOnlyTitle")}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("dashboard.layoutNativeOnlyHint")}
                </p>
                <div className="text-muted-foreground flex items-center gap-2 px-3 pt-2 pb-1 text-xs font-medium tracking-wide uppercase">
                  <span className="flex-1" aria-hidden="true" />
                  <span className="w-12 text-center">
                    {t("dashboard.layoutTileColumn")}
                  </span>
                  <span className="w-12 text-center">
                    {t("dashboard.layoutChartColumn")}
                  </span>
                </div>
                {nativeWidgets.map((widget) => {
                  const label = t(
                    NATIVE_ONLY_WIDGET_LABEL_KEYS[widget.id] ?? widget.id,
                  );
                  return (
                    <StaticWidgetRow
                      key={widget.id}
                      widget={widget}
                      disabled={saveMutation.isPending}
                      labels={{
                        tileColumn: t("dashboard.layoutTileColumn"),
                        chartColumn: t("dashboard.layoutChartColumn"),
                        widgetLabel: label,
                      }}
                      onToggleTile={toggleTile}
                      onToggleChart={toggle}
                    />
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {dirty && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => setDraft(null)}
            disabled={widgetWritesBusy(
              saveMutation.isPending,
              ringMutation.isPending,
            )}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => layout && saveMutation.mutate(layout)}
            // v1.32.16 (issue #581) — disabled while EITHER write is in
            // flight so a Save can't be issued mid ring-write and vice versa.
            disabled={widgetWritesBusy(
              saveMutation.isPending,
              ringMutation.isPending,
            )}
          >
            {saveMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </div>
      )}

      {!dirty && remote && (
        <p className="text-muted-foreground text-xs">
          {layout &&
          JSON.stringify(layout.widgets) ===
            JSON.stringify(DEFAULT_DASHBOARD_LAYOUT.widgets)
            ? t("dashboard.layoutUsingDefaults")
            : t("dashboard.layoutCustomized")}
        </p>
      )}
    </SettingsCard>
  );
}

/**
 * v1.4.47 W4 — sortable row primitive extracted from the section render
 * so the @dnd-kit `useSortable` hook stays scoped to one row. Translation
 * strings are passed in pre-resolved (rather than calling `useTranslations`
 * inside) so this component stays cheap to re-render for the 13+ rows.
 *
 * The drag handle is the only listener-bearing surface — the row body
 * stays click-through so the switches and arrow buttons keep working.
 * Pointer activation has a 6 px distance constraint (configured on the
 * parent sensor) so a tap on the handle never accidentally drags.
 */
interface SortableWidgetRowProps {
  widget: {
    id: DashboardWidgetId;
    visible: boolean;
    tileVisible?: boolean;
    order: number;
  };
  labelKey: string;
  index: number;
  total: number;
  dragHintId: string;
  disabled: boolean;
  labels: {
    tileColumn: string;
    chartColumn: string;
    moveUp: string;
    moveDown: string;
    dragHandle: string;
    widgetLabel: string;
  };
  onToggleTile: (id: DashboardWidgetId, value: boolean) => void;
  onToggleChart: (id: DashboardWidgetId, value: boolean) => void;
  onMove: (id: DashboardWidgetId, delta: -1 | 1) => void;
}

function SortableWidgetRow({
  widget,
  index,
  total,
  dragHintId,
  disabled,
  labels,
  onToggleTile,
  onToggleChart,
  onMove,
}: SortableWidgetRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: widget.id });

  // v1.4.48 L7 — honour the OS `prefers-reduced-motion` preference. The
  // rest of HealthLog pairs every transition with a `motion-reduce`
  // companion; dnd-kit's default `transform 250ms ease` was the lone
  // surface that ignored it. Short-circuit to `none` when reduced
  // motion is requested so dragged rows snap to place instead of
  // sliding through the list.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  const tileChecked =
    typeof widget.tileVisible === "boolean"
      ? widget.tileVisible
      : widget.visible;

  return (
    // v1.4.29 — row sized at 48 px (`min-h-12`) with 44-px mobile tap
    // targets preserved on the trailing arrow buttons (`size-11`),
    // shrunk to `sm:size-9` on desktop. v1.4.47 W4 — `isDragging`
    // raises the row visually (elevation + accent ring) so the ghost
    // overlay is unambiguous during a drag.
    <div
      ref={setNodeRef}
      style={style}
      data-slot="widget-row"
      data-dragging={isDragging ? "true" : undefined}
      className={`border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 ${
        isDragging ? "ring-primary z-10 opacity-90 shadow-lg ring-2" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${labels.dragHandle} — ${labels.widgetLabel}`}
        // v1.4.47 W4 — `aria-describedby` is set after `{...attributes}`
        // so our shared hint paragraph wins over dnd-kit's own announcer
        // hookup. The announcer still fires on drag-start / drag-over /
        // drag-end via the screenReaderInstructions slot below.
        aria-describedby={dragHintId}
        title={labels.dragHandle}
        disabled={disabled}
        data-slot="widget-drag-handle"
        // v1.4.47 W10 design-H1 — extend the WCAG 2.5.5 hit target to
        // 44 × 44 px via a `::before` pseudo-element while keeping the
        // visible GripVertical at 28 px (matches the Switch primitive
        // pattern from v1.4.43 W5-H1). v1.4.47 W10 design-M1 — drop
        // dnd-kit's CSS transition under prefers-reduced-motion.
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative -m-1 inline-flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded transition-colors before:absolute before:inset-[-8px] before:content-[''] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="flex-1 truncate text-sm" title={labels.widgetLabel}>
        {labels.widgetLabel}
      </span>
      <div className="flex w-12 justify-center">
        <Switch
          checked={tileChecked}
          onCheckedChange={(v) => onToggleTile(widget.id, v)}
          aria-label={`${labels.widgetLabel} — ${labels.tileColumn}`}
          disabled={disabled}
          data-slot="widget-tile-switch"
        />
      </div>
      <div className="flex w-12 justify-center">
        <Switch
          checked={widget.visible}
          onCheckedChange={(v) => onToggleChart(widget.id, v)}
          aria-label={`${labels.widgetLabel} — ${labels.chartColumn}`}
          disabled={disabled}
          data-slot="widget-chart-switch"
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(widget.id, -1)}
        disabled={index === 0 || disabled}
        aria-label={labels.moveUp}
      >
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(widget.id, 1)}
        disabled={index === total - 1 || disabled}
        aria-label={labels.moveDown}
      >
        <ArrowDown className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * issue #581 — one row in the native-only group: the same two switches as a
 * widget row above, without the drag handle or the arrow buttons. Placement
 * of these widgets belongs to the client that draws them, so the web offers
 * visibility and nothing it cannot honour.
 */
function StaticWidgetRow({
  widget,
  disabled,
  labels,
  onToggleTile,
  onToggleChart,
}: {
  widget: {
    id: DashboardWidgetCatalogueId;
    visible: boolean;
    tileVisible?: boolean;
    order: number;
  };
  disabled: boolean;
  labels: { tileColumn: string; chartColumn: string; widgetLabel: string };
  onToggleTile: (id: DashboardWidgetCatalogueId, value: boolean) => void;
  onToggleChart: (id: DashboardWidgetCatalogueId, value: boolean) => void;
}) {
  const tileChecked =
    typeof widget.tileVisible === "boolean"
      ? widget.tileVisible
      : widget.visible;

  return (
    <div
      data-slot="native-widget-row"
      data-widget-id={widget.id}
      className="border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2"
    >
      <span className="flex-1 truncate text-sm" title={labels.widgetLabel}>
        {labels.widgetLabel}
      </span>
      <div className="flex w-12 justify-center">
        <Switch
          checked={tileChecked}
          onCheckedChange={(v) => onToggleTile(widget.id, v)}
          aria-label={`${labels.widgetLabel} — ${labels.tileColumn}`}
          disabled={disabled}
          data-slot="widget-tile-switch"
        />
      </div>
      <div className="flex w-12 justify-center">
        <Switch
          checked={widget.visible}
          onCheckedChange={(v) => onToggleChart(widget.id, v)}
          aria-label={`${labels.widgetLabel} — ${labels.chartColumn}`}
          disabled={disabled}
          data-slot="widget-chart-switch"
        />
      </div>
    </div>
  );
}

/**
 * v1.27.8 — sortable row for one SELECTED hero score ring. Mirrors the
 * `SortableWidgetRow` interaction exactly (drag handle + arrow buttons +
 * switch) so the two lists in this section share one sorting language;
 * only the payload differs — the ring order is the `selectedScoreRings`
 * array itself, applied instantly through the ring mutation.
 */
function SortableRingRow({
  ringId,
  label,
  index,
  total,
  dragHintId,
  disabled,
  pinned = false,
  moveUpLabel,
  moveDownLabel,
  dragHandleLabel,
  onToggle,
  onMove,
}: {
  ringId: HeroRingId;
  label: string;
  index: number;
  total: number;
  dragHintId: string;
  disabled: boolean;
  /**
   * v1.27.27 — the health-score anchor ring: always present, no on/off
   * switch (a disabled, checked switch communicates the locked-on state),
   * but reorderable like any other ring.
   */
  pinned?: boolean;
  moveUpLabel: string;
  moveDownLabel: string;
  dragHandleLabel: string;
  onToggle: (id: ScoreRingId, value: boolean) => void;
  onMove: (id: HeroRingId, delta: -1 | 1) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ringId });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="score-ring-row"
      data-ring={ringId}
      data-dragging={isDragging ? "true" : undefined}
      className={`border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 ${
        isDragging ? "ring-primary z-10 opacity-90 shadow-lg ring-2" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${dragHandleLabel} — ${label}`}
        aria-describedby={dragHintId}
        title={dragHandleLabel}
        disabled={disabled}
        data-slot="score-ring-drag-handle"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative -m-1 inline-flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded transition-colors before:absolute before:inset-[-8px] before:content-[''] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="flex-1 truncate text-sm" title={label}>
        {label}
      </span>
      <Switch
        checked
        onCheckedChange={
          pinned ? undefined : (v) => onToggle(ringId as ScoreRingId, v)
        }
        // The health-score anchor cannot be switched off — a disabled,
        // checked switch reads as "always on, locked".
        disabled={disabled || pinned}
        aria-label={label}
        data-slot="score-ring-switch"
        data-ring={ringId}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(ringId, -1)}
        disabled={index === 0 || disabled}
        aria-label={moveUpLabel}
      >
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(ringId, 1)}
        disabled={index === total - 1 || disabled}
        aria-label={moveDownLabel}
      >
        <ArrowDown className="h-4 w-4" />
      </Button>
    </div>
  );
}
