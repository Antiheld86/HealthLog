import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.15.13 — the new filter bar (source select + date range) and the
 * page-scoped multi-select chrome (per-row + select-all checkboxes) on
 * the measurements management list. Server-render assertions only — the
 * selection action bar's count-driven render is covered by the pure
 * `selection.test.ts` math + the integration suite; here we pin that the
 * new controls actually mount with their labelled, keyboard-operable
 * checkboxes.
 */

const baseMeasurements = [
  {
    id: "m-1",
    type: "WEIGHT",
    value: 81.5,
    unit: "kg",
    source: "MANUAL",
    measuredAt: "2026-05-09T08:30:00.000Z",
    notes: null,
  },
  {
    id: "m-2",
    type: "WEIGHT",
    value: 80.9,
    unit: "kg",
    source: "WITHINGS",
    measuredAt: "2026-05-08T08:30:00.000Z",
    notes: null,
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/measurements",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { measurements: baseMeasurements, meta: { total: 2 } },
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
import { MeasurementList } from "../measurement-list";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MeasurementList />
    </I18nProvider>,
  );
}

describe("MeasurementList — filter bar + multi-select chrome", () => {
  // v1.16.1 — the per-page Select/date-input row migrated to the unified
  // `<FilterBar>` pill rail (date range · type · source pills + count).
  // The date inputs now live inside the pill's popover (closed in SSR),
  // so the guard pins the labelled pill triggers instead.
  it("renders the filter rail with type, source, date-range and value pills", () => {
    const html = render("en");
    expect(html).toContain('data-slot="filter-bar"');
    expect(html).toContain('aria-label="Type"');
    expect(html).toContain('aria-label="Source"');
    expect(html).toContain('aria-label="Date range"');
    // v1.18.5 — value-range pill rides the rail for the raw per-sample
    // list (the default `ALL` type is not a day-grouped/sleep type).
    expect(html).toContain('aria-label="Value"');
    const pills = html.match(/data-slot="filter-bar-pill"/g);
    expect(pills?.length).toBe(4);
  });

  it("renders labelled selection checkboxes (per-row + select-all)", () => {
    const html = render("en");
    // The shared Checkbox primitive carries data-slot="checkbox".
    const boxes = html.match(/data-slot="checkbox"/g);
    // 1 header select-all + 2 selectable rows (desktop) + 2 rows (mobile).
    expect(boxes?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(html).toContain('aria-label="Select all on this page"');
    expect(html).toContain('aria-label="Select row"');
  });

  it("localises the new chrome in German", () => {
    const html = render("de");
    expect(html).toContain('aria-label="Quelle"');
    expect(html).toContain('aria-label="Zeitraum"');
    expect(html).toContain('aria-label="Alle auf dieser Seite auswählen"');
  });
});
