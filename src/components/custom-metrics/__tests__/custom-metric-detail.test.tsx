import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type {
  CustomMetricDto,
  CustomMetricEntryDto,
  CustomMetricEntryListResponse,
} from "../types";

/**
 * The custom-metric detail page mirrors the labs biomarker detail: a
 * numbers-first stat strip over the values, the (lazy) chart, and the value
 * controls. This test seeds the metric + value queries and asserts the heading,
 * the stat strip, the chart placeholder, and the controls all paint.
 */

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiDelete: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: "u1" } }),
}));

import { CustomMetricDetail } from "../custom-metric-detail";

const METRIC_ID = "cm-1";

const METRIC: CustomMetricDto = {
  id: METRIC_ID,
  name: "Morning grip strength",
  unit: "kg",
  targetLow: 20,
  targetHigh: 60,
  decimals: 1,
  description: "Right-hand grip measured first thing.",
  correlationEnabled: false,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function entry(
  id: string,
  value: number,
  measuredAt: string,
): CustomMetricEntryDto {
  return {
    id,
    customMetricId: METRIC_ID,
    value,
    unit: "kg",
    measuredAt,
    note: null,
    createdAt: measuredAt,
  };
}

const LIST: CustomMetricEntryListResponse = {
  entries: [
    entry("e3", 45, "2026-06-20T08:00:00.000Z"),
    entry("e2", 43, "2026-05-20T08:00:00.000Z"),
    entry("e1", 41, "2026-04-20T08:00:00.000Z"),
  ],
  meta: { total: 3, limit: 200, offset: 0 },
};

function renderWithCache() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(queryKeys.customMetricDetail(METRIC_ID), METRIC);
  queryClient.setQueryData(
    queryKeys.customMetricEntries({
      customMetricId: METRIC_ID,
      sortDir: "desc",
    }),
    { pages: [LIST], pageParams: [0] },
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <CustomMetricDetail customMetricId={METRIC_ID} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<CustomMetricDetail>", () => {
  const html = renderWithCache();

  it("paints the metric heading", () => {
    expect(html).toContain("Morning grip strength");
  });

  it("paints the user description", () => {
    expect(html).toContain("Right-hand grip measured first thing.");
  });

  it("paints the numbers-first stat strip", () => {
    expect(html).toContain('data-slot="metric-stat-strip"');
  });

  it("paints the chart placeholder (lazy chart shell)", () => {
    expect(html).toContain('data-slot="skeleton"');
  });

  it("offers the edit + delete controls with hover tooltips", () => {
    expect(html).toContain('title="Edit"');
    expect(html).toContain('title="Delete"');
  });
});
