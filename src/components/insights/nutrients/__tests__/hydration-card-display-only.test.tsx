import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * The hydration card is a display-only surface: it shows the synced day
 * total and the 30-day bar chart, and it must NOT offer any in-app water
 * entry (the manual quick-add was removed — water arrives by sync only).
 * The card and its sync-fed display stay; the add button and its sheet go.
 */

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      unit: "mL",
      days: [{ day: "2026-08-08", amount: 1500 }],
      reference: { value: 2000 },
    },
    isLoading: false,
    isError: false,
    refetch: () => undefined,
  }),
}));

vi.mock("@/components/charts/nutrient-daily-bar-chart-dynamic", () => ({
  NutrientDailyBarChartDynamic: () => <div data-testid="hydration-bar-chart" />,
}));

import { HydrationCard } from "../hydration-card";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <HydrationCard />
    </I18nProvider>,
  );
}

describe("<HydrationCard> — display only, no in-app water entry", () => {
  it("renders the synced day total and chart", () => {
    const html = render();
    expect(html).toContain('data-slot="nutrients-hydration-today"');
    expect(html).toContain('data-testid="hydration-bar-chart"');
  });

  it("offers no water-entry affordance", () => {
    const html = render();
    expect(html).not.toContain('data-slot="nutrients-hydration-add"');
  });
});
