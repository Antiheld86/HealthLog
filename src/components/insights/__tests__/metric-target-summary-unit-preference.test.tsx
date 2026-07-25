import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.32.27 — the target reference panel follows the metric/imperial
 * preference.
 *
 * `/api/insights/targets` stays canonical (kg for weight); the panel
 * converts once and hands the converted pair to the range bar, the
 * status pill, and the edit sheet's seed. These assertions read the
 * range bar's axis labels out of the SSR markup — the one place the
 * band endpoints and their unit are rendered as plain text rather than
 * inside a portalled tooltip.
 */

const authUser = vi.hoisted(() => ({
  value: null as { unitPreference?: string } | null,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: vi.fn(() => ({ isAuthenticated: true, user: authUser.value })),
}));

const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { MetricTargetSummary } = await import("../metric-target-summary");

/** A weight target as the route emits it: canonical kilograms. */
const weightPayload = {
  targets: [
    {
      type: "WEIGHT",
      label: "Weight",
      current: 72.5,
      average30: 73.1,
      unit: "kg",
      range: { min: 60, max: 80 },
      classification: { category: "Normal", color: "green" },
      source: "WHO",
      daysInRange7d: 5,
      daysLogged7d: 7,
      daysInRange30d: 20,
      daysLogged30d: 30,
      insufficientData: false,
      consistency7d: ["in", "in", "out", "in", "in", "near", "in"] as const,
    },
  ],
  bpDiastolic: { current: null, average30: null, range: null },
};

function renderWeightPanel(unitPreference: string | null): string {
  authUser.value = unitPreference ? { unitPreference } : null;
  useQueryMock.mockReturnValue({ data: weightPayload });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MetricTargetSummary slug="weight" />
    </I18nProvider>,
  );
}

describe("<MetricTargetSummary> under a unit preference", () => {
  it("renders the weight band in pounds for an imperial account", () => {
    const html = renderWeightPanel("imperial");
    // 60 kg → 132.3 lb, 80 kg → 176.4 lb.
    expect(html).toContain("132.3 lb");
    expect(html).toContain("176.4 lb");
    expect(html).not.toContain("60 kg");
    expect(html).not.toContain("80 kg");
  });

  it("leaves the weight band in kilograms for a metric account", () => {
    const html = renderWeightPanel("metric");
    expect(html).toContain("60 kg");
    expect(html).toContain("80 kg");
    expect(html).not.toContain("lb");
  });

  it("treats a payload with no preference as metric", () => {
    // A stale `/api/auth/me` payload must never silently rescale a band.
    expect(renderWeightPanel(null)).toBe(renderWeightPanel("metric"));
  });
});
