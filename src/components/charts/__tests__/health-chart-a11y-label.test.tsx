import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import deMessages from "../../../../messages/de.json";

/**
 * Chart accessibility — the rendered chart must expose an image role with
 * a non-empty data-summary label so a screen reader announces the series
 * instead of skipping a silent SVG. Mirrors the empty-window render test:
 * mock auth + react-query, render to static markup, assert the DOM.
 */

function buildData(): unknown[] {
  const out: Array<{ date: string; timestamp: number; PULSE: number }> = [];
  // Ten daily points ending half a day before now — the range tabs are
  // calendar-day windows anchored on now (v1.37.29), so an absolute-dated
  // fixture would age out of the default window and render the empty state.
  const base = Date.now() - 12 * 3_600_000;
  for (let i = 0; i < 10; i++) {
    out.push({
      date: `p${i}`,
      timestamp: base - (9 - i) * 86_400_000,
      PULSE: 60 + i,
    });
  }
  return out;
}

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

describe("<HealthChart> — accessibility label", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("wraps the chart in role=img with a non-empty aria-label when data is present", async () => {
    const data = buildData();

    vi.doMock("@tanstack/react-query", () => ({
      // `health-chart` imports `keepPreviousData` for its placeholder option;
      // the identity stand-in keeps the module-level destructure satisfied.
      keepPreviousData: (previous: unknown) => previous,
      useQuery: () => ({ data, isLoading: false }),
      useQueryClient: () => ({
        cancelQueries: () => Promise.resolve(),
        getQueryData: () => undefined,
        setQueryData: () => undefined,
        invalidateQueries: () => Promise.resolve(),
      }),
      useMutation: () => ({ mutate: () => undefined, isPending: false }),
    }));

    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <HealthChart types={["PULSE"]} title="Pulse" unit="bpm" />
      </I18nProvider>,
    );

    expect(html).toContain('role="img"');
    // A role=img wrapper with an empty/absent label is worse than none —
    // assert the aria-label attribute carries actual text.
    const match = html.match(/role="img"[^>]*aria-label="([^"]*)"/);
    expect(match?.[1] ?? "").not.toBe("");

    vi.doUnmock("@tanstack/react-query");
  });
});
