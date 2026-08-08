import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.8.6 QA — the in-target share must appear exactly once on the mood
 * page. The canonical surface is `<MoodInTargetTile>`; when it renders
 * (inTargetPct present) the same-number `in-target` takeaway is dropped
 * from the narrative feed so the percentage is not duplicated one row
 * below the headline tile.
 *
 * Driven against `<MoodInsightsBreakdowns>` rather than its parent since the
 * breakdown cluster moved into its own `next/dynamic` chunk: under a static
 * render the parent paints the loader skeleton and nothing this file is about
 * is in the markup. The breakdown module takes the resolved payload as a prop,
 * so the aggregate no longer has to be seeded into a query cache to reach the
 * assertion. The provider and the auth stub stay because the "what stands
 * out" card inside the cluster fetches the discovery surface itself.
 */

// `useAuth` runs its own /me query; stub it to a signed-in user so the
// self-fetching card inside the cluster resolves without a request.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isLoading: false,
    isAuthenticated: true,
    error: null,
    refetch: () => {},
  }),
}));

import { MoodInsightsBreakdowns } from "../mood-insights-breakdowns";
import type { MoodInsightsResponse } from "../mood-insights-shared";

type Response = {
  summary: { totalEntries: number; inTargetPct: number | null };
  heatmap: { windowDays: number; cells: [] };
  distribution: [];
  weekday: [];
  timeOfDay: {
    buckets: [];
    reliable: boolean;
    best: null;
    worst: null;
  };
  stability: null;
  tags: [];
  structuredTags: [];
  narratives: Array<{
    kind: string;
    messageKey: string;
    vars: Record<string, string>;
  }>;
  correlations: {
    sleep: EmptyCorrelation;
    steps: EmptyCorrelation;
    pulse: EmptyCorrelation;
    weight: EmptyCorrelation;
    bloodPressureSystolic: EmptyCorrelation;
  };
};

type EmptyCorrelation = { result: null; points: []; n: number };
const emptyCorrelation: EmptyCorrelation = { result: null, points: [], n: 0 };

function renderWithData(data: Response) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <MoodInsightsBreakdowns
          data={data as unknown as MoodInsightsResponse}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function baseData(inTargetPct: number | null): Response {
  return {
    summary: { totalEntries: 12, inTargetPct },
    heatmap: { windowDays: 30, cells: [] },
    distribution: [],
    weekday: [],
    timeOfDay: { buckets: [], reliable: false, best: null, worst: null },
    stability: null,
    tags: [],
    structuredTags: [],
    narratives: [
      {
        kind: "in-target",
        messageKey: "insights.mood.narrative.inTarget",
        vars: { pct: "72" },
      },
      {
        kind: "streak",
        messageKey: "insights.mood.narrative.streak",
        vars: { days: "5" },
      },
    ],
    correlations: {
      sleep: emptyCorrelation,
      steps: emptyCorrelation,
      pulse: emptyCorrelation,
      weight: emptyCorrelation,
      bloodPressureSystolic: emptyCorrelation,
    },
  };
}

describe("<MoodInsightsBreakdowns> — in-target dedup", () => {
  it("renders the tile and drops the duplicate in-target narrative", () => {
    const html = renderWithData(baseData(72));
    // The tile carries the percentage exactly once.
    expect((html.match(/72%/g) ?? []).length).toBe(1);
    // The feed's in-target sentence is suppressed.
    expect(html).not.toContain("of the last 30 days");
    // The tile is still present.
    expect(html).toContain("of recent days in your good-mood range");
    // Other narratives survive.
    expect(html).toContain("5 days in a row");
  });

  it("keeps the in-target narrative when no tile renders", () => {
    const html = renderWithData(baseData(null));
    // No tile (inTargetPct null) → the narrative is the only surface.
    expect(html).toContain("72% of the last 30 days");
  });
});
