/**
 * v1.17.1 — onboarding goal slugs + dashboard seeding.
 *
 * The closed set of goal slugs the GoalsChipPicker offers, plus the
 * server-authoritative seeding that turns a goal selection into a
 * personalization signal: which dashboard tiles get promoted to the
 * top and made visible. Goals are NOT a clinical target store — the
 * targets surface (`/api/insights/targets`) is fully derived from
 * height/age/gender + clinical references. Their only leverage is the
 * one-time dashboard tile pinning below, applied by
 * `/api/onboarding/step` while the layout is still unset. Nothing else
 * reads `User.onboardingGoals` — the column is collected, seeded from
 * once, and then inert.
 *
 * One home for the slug enum so the API validation
 * (`/api/onboarding/step`), the client picker, and the seeding all
 * read the same source — same-key drift was the v1.4.16 dashboard-enum
 * bug class.
 */
import {
  DEFAULT_DASHBOARD_LAYOUT,
  serializeDashboardLayout,
  type DashboardLayout,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";

/** Closed slug set — mirrors `OnboardingGoalSlug` in GoalsChipPicker. */
export const ONBOARDING_GOAL_SLUGS = [
  "weight-management",
  "bp-tracking",
  "glucose-tracking",
  "sleep-improvement",
  "medication-compliance",
  "general-wellness",
] as const;

export type OnboardingGoalSlug = (typeof ONBOARDING_GOAL_SLUGS)[number];

export function isOnboardingGoalSlug(
  value: unknown,
): value is OnboardingGoalSlug {
  return (
    typeof value === "string" &&
    (ONBOARDING_GOAL_SLUGS as readonly string[]).includes(value)
  );
}

/**
 * Slug → dashboard widget ids to promote. `general-wellness` maps to
 * nothing — it carries no tile preference, so a general-wellness-only
 * selection leaves the default layout untouched. Ids must be members
 * of `DASHBOARD_WIDGET_IDS`; the seed never invents an id.
 */
export const GOAL_WIDGET_SEED_MAP: Record<
  OnboardingGoalSlug,
  readonly DashboardWidgetId[]
> = {
  "weight-management": ["weight", "bodyFat"],
  "bp-tracking": ["bp", "bpInTarget"],
  "glucose-tracking": ["glucose"],
  "sleep-improvement": ["sleep"],
  "medication-compliance": ["medications"],
  "general-wellness": [],
};

/**
 * Build the seeded dashboard layout for a goal selection.
 *
 * Returns a layout where the goal-mapped tiles are promoted to the top
 * of the order (preserving their relative order within the default
 * layout) and forced visible on both surfaces; every other tile keeps
 * its default config, shifted down. Returns `null` when there is
 * nothing to promote (empty selection or general-wellness only) so the
 * caller can skip the write entirely and leave the column null →
 * default layout.
 *
 * This is a ONE-TIME seed: the caller MUST gate it on
 * `User.dashboardWidgetsJson == null` so it never clobbers a user who
 * already arranged tiles.
 */
export function buildGoalSeededDashboardLayout(
  goals: readonly string[] | null | undefined,
): DashboardLayout | null {
  if (!goals || goals.length === 0) return null;
  const promoted = new Set<DashboardWidgetId>();
  for (const slug of goals) {
    if (!isOnboardingGoalSlug(slug)) continue;
    for (const id of GOAL_WIDGET_SEED_MAP[slug]) promoted.add(id);
  }
  if (promoted.size === 0) return null;

  const base = DEFAULT_DASHBOARD_LAYOUT.widgets;
  const promotedWidgets = base.filter((w) =>
    promoted.has(w.id as DashboardWidgetId),
  );
  const rest = base.filter((w) => !promoted.has(w.id as DashboardWidgetId));

  const ordered = [...promotedWidgets, ...rest].map((w, index) => ({
    ...w,
    // Force the goal-mapped tiles visible on both surfaces; leave the
    // rest exactly as the default layout had them.
    ...(promoted.has(w.id as DashboardWidgetId)
      ? { visible: true, tileVisible: true }
      : {}),
    order: index,
  }));

  return serializeDashboardLayout({
    ...DEFAULT_DASHBOARD_LAYOUT,
    widgets: ordered,
  });
}
