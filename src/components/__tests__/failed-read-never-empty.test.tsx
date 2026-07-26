import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import en from "../../../messages/en.json";

/**
 * A failed read must never render as an absence of data.
 *
 * "No data yet" is a factual claim about the user's record. Making it when the
 * read failed is a false statement about their health history — worst of all on
 * the mental-wellbeing surface, where a user with months of screening results
 * was told, in a mental-health context, that they had never taken an
 * assessment.
 *
 * Each surface must tell three states apart: loading, failed, and genuinely
 * empty. These tests pin the failed/empty split; the loading branch is asserted
 * where it is SSR-observable.
 *
 * SSR-only convention (`renderToStaticMarkup`, no `@testing-library/react`), so
 * the error state is produced by seeding the query cache with a settled failure
 * rather than by driving a real fetch.
 */

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiPost: () => new Promise(() => {}),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { gender: "FEMALE", modules: {} },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { MentalWellbeing } from "@/components/mental-health/mental-wellbeing";
import { MicronutrientsCard } from "@/components/insights/nutrients/micronutrients-card";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // An errored query would otherwise refetch on mount, and the observer
        // reports that intent as an optimistic pending state during the server
        // render — which would hide the very branch under test.
        retryOnMount: false,
        staleTime: Infinity,
      },
    },
  });
}

/**
 * Drive `queryKey` to a settled failure through the public prefetch path, so
 * the SSR render below observes exactly the state a real failed read leaves in
 * the cache.
 */
async function seedFailure(
  client: QueryClient,
  queryKey: readonly unknown[],
): Promise<void> {
  await client.prefetchQuery({
    queryKey: queryKey as unknown[],
    queryFn: () => Promise.reject(new Error("read failed")),
    retry: false,
  });
}

function render(node: React.ReactNode, client: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("mental wellbeing — screening history", () => {
  const mh = en.mentalHealth;

  it("renders the error state with a retry when the history read fails", async () => {
    const client = makeClient();
    await seedFailure(client, queryKeys.mentalHealthAssessments());
    const html = render(<MentalWellbeing />, client);

    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain(mh.historyLoadError);
    expect(html).toContain(en.common.retry);
    // The load-bearing assertion: the instrument cards' "not taken yet" copy
    // must NOT appear. That sentence is a claim about the user's record.
    expect(html).not.toContain(mh.noResultYet);
  });

  it("still renders the instrument cards when the record is genuinely empty", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.mentalHealthAssessments(), {
      assessments: [],
    });
    const html = render(<MentalWellbeing />, client);

    expect(html).not.toContain('data-slot="query-error-card"');
    // An honest empty record: the cards render and invite a first check-in.
    expect(html).toContain(mh.noResultYet);
  });

  it("shows neither the empty copy nor an error while the read is in flight", () => {
    const html = render(<MentalWellbeing />, makeClient());
    expect(html).not.toContain('data-slot="query-error-card"');
    expect(html).not.toContain(mh.noResultYet);
  });
});

describe("micronutrients card", () => {
  const mn = en.nutrients.micronutrients;

  it("renders the error state with a retry when the nutrient read fails", async () => {
    const client = makeClient();
    await seedFailure(client, queryKeys.nutrientIntake(30));
    const html = render(<MicronutrientsCard />, client);

    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain(mn.loadError);
    expect(html).toContain(en.common.retry);
    expect(html).not.toContain(mn.emptyTitle);
  });

  it("still renders the empty state when the record is genuinely empty", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.nutrientIntake(30), { nutrients: [] });
    const html = render(<MicronutrientsCard />, client);

    expect(html).not.toContain('data-slot="query-error-card"');
    expect(html).toContain(mn.emptyTitle);
  });
});

/**
 * The remaining surfaces in the sweep are pages whose render depends on the
 * router / module gate, which the SSR-only convention cannot drive. Pin their
 * contract structurally instead: each must read `isError` from its query and
 * hand a retry to the shared error card, so a later edit cannot quietly drop
 * the branch and fall back through to the empty state.
 */
describe("read-failure branch is wired on every swept surface", () => {
  const surfaces = [
    "src/components/mental-health/mental-wellbeing.tsx",
    "src/app/insights/workouts/page-client.tsx",
    "src/app/medications/[id]/page.tsx",
    "src/components/custom-metrics/custom-metric-values-list.tsx",
    "src/app/achievements/page.tsx",
    "src/components/insights/nutrients/micronutrients-card.tsx",
    // A failed comprehensive read used to fall through to "you haven't added
    // any medications yet" — with a CTA inviting someone on a full daily
    // regimen to re-enter what the app already holds.
    "src/app/insights/medications/page.tsx",
    // The three sleep-rhythm cards share one read, so the PAGE owns the single
    // error notice rather than each card painting its own copy of it.
    "src/app/insights/sleep/page.tsx",
  ] as const;

  for (const rel of surfaces) {
    it(`${rel} reads isError and offers a retry`, () => {
      const source = readFileSync(join(process.cwd(), rel), "utf8");
      expect(source).toMatch(/isError/);
      expect(source).toMatch(/onRetry=/);
      expect(source).toMatch(/refetch/);
    });
  }
});

describe("the shared sleep-rhythm read has exactly one error notice", () => {
  it("no rhythm card renders the load-error string itself", () => {
    // One failed read used to paint the same sentence three times on
    // /insights/sleep, none of them offering a retry.
    for (const rel of [
      "src/components/insights/sleep/chronotype-section.tsx",
      "src/components/insights/sleep/average-sleep-section.tsx",
      "src/components/insights/sleep/sleep-rhythm-section.tsx",
    ]) {
      const source = readFileSync(join(process.cwd(), rel), "utf8");
      expect(source).not.toContain("rhythm.loadError");
    }
    const page = readFileSync(
      join(process.cwd(), "src/app/insights/sleep/page.tsx"),
      "utf8",
    );
    expect(page).toContain("rhythm.loadError");
    expect(page).toContain("QueryErrorCard");
  });
});

/**
 * The /insights/sleep page renders the shared rhythm error itself, so the
 * behaviour is observable — a structural check would still pass if the gate
 * were short-circuited, which the mutation check proved.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/insights/sleep",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => ({ isEmpty: false }),
}));

// The shared rhythm read is mocked at the hook rather than seeded in the cache:
// the hook sets its own staleTime, which makes a cache-seeded failure look like
// a pending refetch during a server render and hides the branch under test.
vi.mock("@/components/insights/sleep/use-sleep-rhythm", () => ({
  useSleepRhythm: () => ({
    data: undefined,
    isLoading: false,
    isError: true,
    refetch: () => {},
  }),
}));

const { default: SleepPage } = await import("@/app/insights/sleep/page");

describe("/insights/sleep — shared rhythm read", () => {
  it("renders exactly one error notice with a retry when the read fails", () => {
    const html = render(<SleepPage />, makeClient());

    // React escapes the apostrophe in the copy, so count the rendered cards
    // rather than the raw bundle string.
    const notices = html.split('data-slot="query-error-card"').length - 1;
    expect(notices).toBe(1);
    expect(html).toContain(en.common.retry);
    // The three sibling cards must not render alongside the notice.
    expect(html).not.toContain('data-slot="chronotype-error"');
  });
});
