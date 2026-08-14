import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.15.13 — the new source filter + date range + page-scoped
 * multi-select chrome on the mood management list. Mirrors the
 * measurements-list guard.
 */

const baseEntries = [
  {
    id: "e-1",
    date: "2026-05-09",
    mood: "GUT",
    score: 4,
    tags: ["work"],
    tagKeys: [],
    note: null,
    source: "MANUAL",
    moodLoggedAt: "2026-05-09T20:00:00.000Z",
  },
  {
    id: "e-2",
    date: "2026-05-08",
    mood: "OKAY",
    score: 3,
    tags: [],
    tagKeys: [],
    note: null,
    source: "MOODLOG",
    moodLoggedAt: "2026-05-08T20:00:00.000Z",
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/mood",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { entries: baseEntries, meta: { total: 2 } },
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MoodList } from "../mood-list";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MoodList />
    </I18nProvider>,
  );
}

describe("MoodList — filter bar + multi-select chrome", () => {
  // v1.16.1 — the per-page Select/date-input row migrated to the unified
  // `<FilterBar>` pill rail; same grammar as the measurements list.
  it("renders the filter rail with mood, source and date-range pills", () => {
    const html = render("en");
    expect(html).toContain('data-slot="filter-bar"');
    expect(html).toContain('aria-label="Mood"');
    expect(html).toContain('aria-label="Source"');
    expect(html).toContain('aria-label="Date range"');
    const pills = html.match(/data-slot="filter-bar-pill"/g);
    expect(pills?.length).toBe(3);
  });

  it("renders labelled selection checkboxes (per-row + select-all)", () => {
    const html = render("en");
    const boxes = html.match(/data-slot="checkbox"/g);
    expect(boxes?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(html).toContain('aria-label="Select all on this page"');
    expect(html).toContain('aria-label="Select row"');
  });

  it("renders the localised non-manual source label, not the raw enum", () => {
    const html = render("en");
    // MOODLOG row paints its localised badge label.
    expect(html).toContain("moodLog");
    expect(html).not.toContain(">MOODLOG<");
  });
});
