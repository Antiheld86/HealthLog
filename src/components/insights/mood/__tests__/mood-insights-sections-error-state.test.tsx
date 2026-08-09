/**
 * The mood-insights regions used to render nothing on a failed read, by
 * documented intent ("degrades gracefully to the line chart"). The maintainer
 * decision is to enforce §6 here like everywhere else: a failed read is not an
 * empty page. The shared query is forced into its error state; the main "rest"
 * region has to surface a `query-error-row` with retry (mirroring the loading
 * convention, which also only paints in the "rest" region).
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isLoading: false,
    isAuthenticated: true,
    error: null,
    refetch: () => {},
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: true,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MoodInsightsSections } from "../mood-insights-sections";

function render(region: "heatmap" | "assessment" | "rest") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MoodInsightsSections region={region} />
    </I18nProvider>,
  );
}

describe("<MoodInsightsSections> — a read failure is honest, not empty", () => {
  it("surfaces a query-error row with retry in the rest region", () => {
    const html = render("rest");
    expect(html).toContain('data-slot="query-error-row"');
    expect(html).toContain('data-slot="query-error-row-retry"');
  });

  it("stays quiet in the heatmap/assessment regions to avoid stacking rows", () => {
    expect(render("heatmap")).toBe("");
    expect(render("assessment")).toBe("");
  });
});
