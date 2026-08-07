import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { AchievementProgress } from "@/lib/gamification/achievements";

/**
 * v1.4.15 phase-B4 — `<RecentAchievementsCard>` contract.
 *
 *   1. `pickRecentUnlocks` — locked entries dropped, unlocked sorted by
 *      `completedAt` descending, capped at the requested limit. Pure.
 *   2. Card render — empty state shows the discovery CTA + link to
 *      `/achievements`; populated state shows the most recent N items
 *      with their localized title + completedAt date.
 */

let mockUser: { modules?: Record<string, boolean> } | null = {};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: mockUser }),
  useAccountOnceMounted: () => mockUser,
}));

// The card paints its skeleton until it is mounted, because the achievements
// cell is shared with `<AchievementUnlockNotifier>` in the app shell: on a
// cold load of the dashboard that cell is often already full by the time this
// card hydrates, where the server had nothing, and a content branch there is a
// hydration mismatch that costs the whole streamed page. These cases are about
// the MOUNTED render, so the flag is stubbed to what it answers from the first
// client re-render on.
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));

let mockData:
  | {
      summary: unknown;
      achievements: AchievementProgress[];
      metrics: unknown;
    }
  | undefined = {
  summary: {},
  achievements: [],
  metrics: {},
};
let mockIsPending = false;

// v1.4.34 IW-F-Perf — the card now reads through the shared
// `useAchievementsQuery` hook; the test mocks the hook directly so the
// network layer + TanStack provider scaffolding stays out of scope.
vi.mock("@/lib/queries/use-achievements-query", () => ({
  useAchievementsQuery: () => ({ data: mockData, isPending: mockIsPending }),
}));

import {
  RecentAchievementsCard,
  pickRecentUnlocks,
} from "../recent-achievements-card";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <RecentAchievementsCard />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsPending = false;
  mockUser = {};
});

const baseAchievement: AchievementProgress = {
  id: "intake-total-1",
  metric: "totalTakenIntakes",
  category: "medication",
  titleKey: "achievements.badges.intakeTotal1.title",
  descriptionKey: "achievements.badges.intakeTotal1.description",
  icon: "Pill",
  format: "count",
  target: 1,
  current: 1,
  points: 8,
  unlocked: true,
  progressPercent: 100,
  completedAt: "2026-04-15T12:00:00.000Z",
  isHidden: false,
};

describe("pickRecentUnlocks", () => {
  it("filters out locked entries", () => {
    const result = pickRecentUnlocks(
      [
        { ...baseAchievement, id: "a", unlocked: true },
        { ...baseAchievement, id: "b", unlocked: false },
      ],
      5,
    );
    expect(result.map((item) => item.id)).toEqual(["a"]);
  });

  it("sorts by completedAt descending and caps at the limit", () => {
    const result = pickRecentUnlocks(
      [
        {
          ...baseAchievement,
          id: "older",
          completedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "newer",
          completedAt: "2026-04-01T00:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "newest",
          completedAt: "2026-04-15T00:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "ancient",
          completedAt: "2025-12-01T00:00:00.000Z",
        },
      ],
      3,
    );
    expect(result.map((item) => item.id)).toEqual(["newest", "newer", "older"]);
  });

  it("places entries without completedAt at the bottom", () => {
    const result = pickRecentUnlocks(
      [
        { ...baseAchievement, id: "no-date", completedAt: null },
        {
          ...baseAchievement,
          id: "dated",
          completedAt: "2026-04-15T00:00:00.000Z",
        },
      ],
      5,
    );
    expect(result.map((item) => item.id)).toEqual(["dated", "no-date"]);
  });
});

describe("<RecentAchievementsCard> — achievements module gate", () => {
  it("renders nothing when the achievements module is disabled", () => {
    // v1.18.0 — an explicit `false` for the module hides the dashboard
    // tile entirely so the surface disappears in lock-step with the page
    // and the 403 route.
    mockUser = { modules: { achievements: false } };
    mockData = {
      summary: {},
      achievements: [
        {
          ...baseAchievement,
          id: "a",
          completedAt: "2026-04-15T12:00:00.000Z",
        },
      ],
      metrics: {},
    };
    expect(render()).toBe("");
  });

  it("renders the tile when the module is enabled (explicit true)", () => {
    mockUser = { modules: { achievements: true } };
    mockData = {
      summary: {},
      achievements: [
        {
          ...baseAchievement,
          id: "a",
          completedAt: "2026-04-15T12:00:00.000Z",
        },
      ],
      metrics: {},
    };
    expect(render()).toContain('data-slot="recent-achievements-card"');
  });

  it("renders the tile by default when the module key is absent (default-on)", () => {
    mockUser = { modules: {} };
    mockData = { summary: {}, achievements: [], metrics: {} };
    expect(render()).toContain('data-slot="recent-achievements-card"');
  });
});

describe("<RecentAchievementsCard>", () => {
  it("renders a skeleton (no content, no empty state) while the query is pending", () => {
    // The flash this guards against: before the query settles the card
    // used to paint the empty / content branch and then retract it once
    // the real payload arrived. The skeleton commits to neither.
    mockIsPending = true;
    mockData = undefined;
    const html = render();
    expect(html).toContain('data-slot="recent-achievements-skeleton"');
    // Neither the empty-state copy nor any content item paints while
    // pending — nothing to retract.
    expect(html).not.toContain("No achievements yet");
    expect(html).not.toContain('data-slot="recent-achievement-item"');
    // The card header still anchors the footprint.
    expect(html).toContain("Recent unlocks");
  });

  it("shows the empty-state CTA when no unlocks exist", () => {
    mockData = { summary: {}, achievements: [], metrics: {} };
    const html = render();
    expect(html).toContain("No achievements yet");
    // Link to /achievements so the user can discover the feature
    expect(html).toContain('href="/achievements"');
    expect(html).toContain("View all");
  });

  it("routes the header through the canonical TileHeader (foreground icon, h2)", () => {
    mockData = { summary: {}, achievements: [], metrics: {} };
    const html = render();
    // Adopts the shared tile-header primitive so it matches sibling tiles…
    expect(html).toContain('data-slot="tile-header"');
    // …with the foreground (never muted) glyph and the h2 heading, not the
    // old muted h-4 / text-sm row.
    expect(html).toContain("Recent unlocks");
    expect(html).not.toMatch(/<h2[^>]*text-sm font-semibold/);
    expect(html).not.toContain("text-muted-foreground h-4 w-4");
  });

  it("renders up to three most-recent unlocks with title + date", () => {
    mockData = {
      summary: {},
      achievements: [
        {
          ...baseAchievement,
          id: "a",
          completedAt: "2026-04-15T12:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "b",
          completedAt: "2026-04-10T12:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "c",
          completedAt: "2026-04-05T12:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "d",
          completedAt: "2026-04-01T12:00:00.000Z",
        },
      ],
      metrics: {},
    };
    const html = render();
    // Card title (always painted)
    expect(html).toContain("Recent unlocks");
    // Three "recent-achievement-item" slots — capped at the limit
    const matches = html.match(/data-slot="recent-achievement-item"/g) ?? [];
    expect(matches.length).toBe(3);
    // Empty-state copy must NOT appear once we have unlocks
    expect(html).not.toContain("No achievements yet");
  });
});
