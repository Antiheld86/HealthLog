import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.8.5 — `<MeasurementList lockedType>` for the insights "all readings"
 * subpage. When pinned to a type the global type selector is suppressed
 * and every row belongs to that metric; the list still paginates and
 * exposes inline edit/delete (unchanged from the unlocked path).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/insights/values/WEIGHT",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      measurements: [
        {
          id: "m1",
          type: "WEIGHT",
          value: 78.4,
          unit: "kg",
          source: "MANUAL",
          measuredAt: "2026-05-30T08:00:00.000Z",
          notes: null,
        },
      ],
      meta: { total: 1 },
    },
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

function render(lockedType?: string) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MeasurementList lockedType={lockedType} />
    </I18nProvider>,
  );
}

describe("MeasurementList — lockedType", () => {
  it("hides the filter rail when locked to a metric", () => {
    const locked = render("WEIGHT");
    const unlocked = render();
    // v1.16.1 — the unlocked list paints the unified `<FilterBar>` pill
    // rail (type pill included); the locked one suppresses the whole
    // rail (the metric is fixed by the route) and keeps only the count.
    expect(unlocked).toContain('data-slot="filter-bar"');
    expect(unlocked).toContain('aria-label="Type"');
    expect(locked).not.toContain('data-slot="filter-bar"');
    expect(locked).not.toContain('role="combobox"');
  });

  it("loads the metric's readings", () => {
    const html = render("WEIGHT");
    // The single seeded WEIGHT row renders with its value + unit.
    expect(html).toContain("78.4");
    expect(html).toContain("kg");
  });
});
