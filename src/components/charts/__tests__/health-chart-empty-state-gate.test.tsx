import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// vi.doMock below invalidates the module registry, so the re-imported
// provider gets a fresh (unprimed) locale cache — pass the DE bundle
// explicitly instead of relying on the vitest.setup.ts seeding.
import deMessages from "../../../../messages/de.json";

/**
 * Sparse-data render contract.
 *
 * The metric chart no longer withholds real data behind a "more days
 * needed" card. Any non-empty window paints the available points — a
 * single marker for one day, a line for two — and adds a subtle inline
 * caption (`chart-sparse-caption`) when fewer than three daily points
 * exist so the user understands more days fill out the trend. Only a
 * genuinely empty window (zero daily points) paints the no-data card.
 */

function buildData(
  rows: Array<{ measuredAt: string; value: number; count?: number }>,
): unknown[] {
  // The queryFn returns daily-aggregated points; mirror that shape so
  // the chart's `useMemo(() => …, [data])` derives the same chartData.
  return rows.map((r) => ({
    date: r.measuredAt.slice(0, 10),
    timestamp: new Date(r.measuredAt).getTime(),
    PULSE: r.value,
  }));
}

/**
 * ISO instant `agoDays` before now (noon-offset). The range tabs are
 * calendar-day windows anchored on now (v1.37.29), so an absolute-dated
 * fixture would age out of the default window and always paint the
 * no-data card instead of the sparse states under test.
 */
function daysAgo(agoDays: number): string {
  return new Date(
    Date.now() - 12 * 3_600_000 - agoDays * 86_400_000,
  ).toISOString();
}

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

async function renderChart(data: unknown[]): Promise<string> {
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
  vi.doUnmock("@tanstack/react-query");
  return html;
}

describe("<HealthChart> — sparse-data render contract", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders the chart (not a withholding card) with a sparse caption for two distinct days", async () => {
    const html = await renderChart(
      buildData([
        { measuredAt: daysAgo(1), value: 70 },
        { measuredAt: daysAgo(0), value: 72 },
      ]),
    );

    // The chart paints the available points + a subtle caption …
    expect(html).toContain('data-slot="chart-sparse-caption"');
    expect(html).toContain("Mehr Messtage füllen den Trend.");
    // … and does NOT fall back to the old withholding empty-state copy.
    expect(html).not.toContain('data-slot="chart-empty-state"');
    expect(html).not.toContain("Mehr Messtage erforderlich");
    expect(html).not.toContain("Erfasse mindestens 3 Einträge");
  });

  it("renders the single marker + sparse caption for one day instead of a bare hint", async () => {
    const html = await renderChart(
      buildData([{ measuredAt: daysAgo(0), value: 70 }]),
    );

    // A single point still renders (Recharts paints the marker) and the
    // caption stays — no withholding card for one real reading.
    expect(html).toContain('data-slot="chart-sparse-caption"');
    expect(html).toContain("Mehr Messtage füllen den Trend.");
    expect(html).not.toContain('data-slot="chart-empty-state"');
    expect(html).not.toContain("Erfasse mindestens 3 Einträge");
  });

  it("renders the no-data card with no sparse caption when the window is empty", async () => {
    const html = await renderChart(buildData([]));

    expect(html).toContain('data-slot="chart-empty-state"');
    expect(html).toContain("Für den gewählten Bereich liegen keine Messungen");
    expect(html).not.toContain('data-slot="chart-sparse-caption"');
  });

  it("omits the sparse caption once three or more distinct days exist", async () => {
    const html = await renderChart(
      buildData([
        { measuredAt: daysAgo(2), value: 68 },
        { measuredAt: daysAgo(1), value: 70 },
        { measuredAt: daysAgo(0), value: 72 },
      ]),
    );

    expect(html).not.toContain('data-slot="chart-sparse-caption"');
    expect(html).not.toContain('data-slot="chart-empty-state"');
  });
});
