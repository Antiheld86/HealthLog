import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.19.0 W11b — preloaded-coverage guard.
 *
 * The dashboard batches a ~30-day series slice and hands each chart its
 * portion via `preloadedSeries`. Pre-fix the chart consumed that slice for
 * ANY range tab wider than 7 days, so selecting the 90 / All tab silently
 * re-rendered the 30-day batched slice instead of fetching the wider
 * window — the user picked "90 days" and still saw ~30.
 *
 * The fix threads `preloadedCoverageDays` (the batch's actual day-span) and
 * reads the preloaded slice ONLY when the requested window fits within it.
 * A wider tab falls through to a real fetch.
 *
 * These tests drive the queryFn through `windowOverride` (which pins the
 * range at mount, observable in `renderToStaticMarkup`) and assert on the
 * fetch the queryFn does — or does not — issue.
 */

const fetchCalls: string[] = [];

vi.mock("@tanstack/react-query", () => ({
  // `health-chart` imports `keepPreviousData` for its placeholder option;
  // the identity stand-in keeps the module-level destructure satisfied.
  keepPreviousData: (previous: unknown) => previous,
  useQuery: ({
    queryFn,
    queryKey,
  }: {
    queryKey: unknown[];
    queryFn: () => Promise<unknown>;
  }) => {
    (globalThis as unknown as { __lastQueryKey?: unknown[] }).__lastQueryKey =
      queryKey;
    void queryFn();
    return { data: [], isLoading: false };
  },
  useQueryClient: () => ({
    cancelQueries: () => Promise.resolve(),
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    invalidateQueries: () => Promise.resolve(),
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

beforeEach(() => {
  fetchCalls.length = 0;
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    fetchCalls.push(String(url));
    return new Response(
      JSON.stringify({ data: { measurements: [], meta: { total: 0 } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

// A 30-day batched slice keyed by type, in the chart's `MeasurementApiRow`
// shape. Its mere presence used to satisfy `usePreloaded` for any > 7-day
// window regardless of how wide the active tab was.
const preloadedSlice = {
  WEIGHT: [{ measuredAt: "2026-06-01T08:00:00.000Z", value: 82 }],
};

describe("<HealthChart> — preloaded-coverage guard (W11b)", () => {
  it("reads the preloaded slice (no fetch) when the window fits coverage", async () => {
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HealthChart
          types={["WEIGHT"]}
          title="Weight"
          unit="kg"
          windowOverride="last30days"
          preloadedSeries={preloadedSlice}
          preloadedCoverageDays={31}
        />
      </I18nProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    // 30-day window ≤ 31-day coverage → preloaded slice is consumed, the
    // queryFn issues no `/api/measurements` network request.
    const measurementsUrl = fetchCalls.find((u) =>
      u.includes("/api/measurements"),
    );
    expect(measurementsUrl).toBeUndefined();

    // Read-mode discriminator pins "preloaded" in the cache key.
    const key = (globalThis as unknown as { __lastQueryKey?: unknown[] })
      .__lastQueryKey;
    expect(key![key!.length - 1]).toBe("preloaded");
  });

  it("fetches the wider window (does NOT read preloaded) when the tab exceeds coverage", async () => {
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HealthChart
          types={["WEIGHT"]}
          title="Weight"
          unit="kg"
          windowOverride="last90days"
          preloadedSeries={preloadedSlice}
          preloadedCoverageDays={31}
        />
      </I18nProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    // 90-day window > 31-day coverage → the chart must fetch the real
    // window rather than re-render the 30-day batched slice.
    const measurementsUrl = fetchCalls.find((u) =>
      u.includes("/api/measurements"),
    );
    expect(measurementsUrl).toBeDefined();
    expect(measurementsUrl!).toMatch(/type=WEIGHT/);
    expect(measurementsUrl!).toMatch(/aggregate=daily/);

    // The cache-key read-mode discriminator must flip to "fetch" so the
    // batched-slice entry and the self-fetched entry never collide.
    const key = (globalThis as unknown as { __lastQueryKey?: unknown[] })
      .__lastQueryKey;
    expect(key![key!.length - 1]).toBe("fetch");
  });

  it("fetches when no coverage is declared, even with a preloaded slice", async () => {
    // A legacy mount that supplies `preloadedSeries` without
    // `preloadedCoverageDays` must not be trusted blindly — coverage
    // defaults to 0 so any > 7-day window self-fetches.
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HealthChart
          types={["WEIGHT"]}
          title="Weight"
          unit="kg"
          windowOverride="last30days"
          preloadedSeries={preloadedSlice}
        />
      </I18nProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const measurementsUrl = fetchCalls.find((u) =>
      u.includes("/api/measurements"),
    );
    expect(measurementsUrl).toBeDefined();
  });
});
