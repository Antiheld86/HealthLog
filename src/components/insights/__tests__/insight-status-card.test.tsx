import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { InsightStatusCard } from "../insight-status-card";

// The last-updated footer reads the profile timezone via `useAuth`; stub it so
// the SSR render does not reach for a QueryClient the static-markup test omits.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "Europe/Berlin" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

/**
 * v1.4.27 — F16 regression cover. The per-metric status text comes
 * out of the AI provider with a literal `metric:<TYPE>` token (the
 * prompt invites the model to embed one so the mother page can render
 * an inline chart). The sub-page does not mount the chart, so the
 * token used to surface verbatim at the tail of the rendered prose.
 * The card now wraps the text in `stripChartTokens` so cached rows
 * from pre-v1.4.27 still render clean while they roll forward.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const baseProps = {
  title: "Pulse",
  icon: null,
  hasProvider: true,
  updatedAt: null,
};

describe("<InsightStatusCard>", () => {
  it("strips a trailing colon-form metric token from rendered prose", () => {
    const html = render(
      <InsightStatusCard
        {...baseProps}
        text="Your pulse is stable. metric:PULSE"
      />,
    );
    expect(html).toContain("Your pulse is stable.");
    expect(html).not.toContain("metric:PULSE");
  });

  it("strips multiple colon-form tokens scattered through the prose", () => {
    const html = render(
      <InsightStatusCard
        {...baseProps}
        title="Blood pressure"
        text="Systolic averaged 132 metric:BLOOD_PRESSURE_SYS over the last 30 days. metric:BLOOD_PRESSURE_DIA"
      />,
    );
    expect(html).toContain("Systolic averaged 132");
    expect(html).not.toContain("metric:BLOOD_PRESSURE_SYS");
    expect(html).not.toContain("metric:BLOOD_PRESSURE_DIA");
  });

  it("strips the capitalised Metric form (v1.4.25 W5b leak shape)", () => {
    const html = render(
      <InsightStatusCard
        {...baseProps}
        title="Blood pressure"
        text="Your Metric Pressure_Sys is elevated relative to last month."
      />,
    );
    expect(html).not.toContain("Metric Pressure_Sys");
    expect(html).toContain("Your");
    expect(html).toContain("is elevated");
  });

  it("renders ordinary prose unchanged when no tokens are present", () => {
    const html = render(
      <InsightStatusCard {...baseProps} text="Pulse stayed inside the band." />,
    );
    expect(html).toContain("Pulse stayed inside the band.");
  });

  it("renders the no-provider setup state when no terminal text exists", () => {
    const html = render(
      <InsightStatusCard {...baseProps} hasProvider={false} text={null} />,
    );
    // v1.18.6 — the no-provider tile is a guided-setup explainer + a
    // Settings link, not a bare "unavailable" line.
    expect(html).toContain("Connect an AI provider");
    expect(html).toContain("Open AI settings");
    expect(html).toContain("/settings/ai");
  });

  it("renders a screened terminal fallback even when its envelope has no provider", () => {
    const html = render(
      <InsightStatusCard
        {...baseProps}
        hasProvider={false}
        text="The assessment could not be completed safely. Your recorded measurements remain available."
      />,
    );

    expect(html).toContain("could not be completed safely");
    expect(html).toContain("recorded measurements remain available");
    expect(html).not.toContain("Connect an AI provider");
    expect(html).not.toContain("because your medication caused");
  });

  it("renders the empty-text state without crashing on null", () => {
    const html = render(<InsightStatusCard {...baseProps} text={null} />);
    // v1.12.2 — the empty state shares the canonical assessment noun.
    expect(html).toContain("No assessment yet.");
  });

  it("never surfaces a cached badge — the card has no cached affordance", () => {
    // v1.11.5 — the top-right "cached" label was removed and the dead
    // `cached` prop was dropped from the contract. The caching behaviour
    // upstream is unchanged; the card simply never announced it, so the
    // assessment reads as authoritative.
    const html = render(
      <InsightStatusCard {...baseProps} text="Pulse stayed inside the band." />,
    );
    expect(html).toContain("Pulse stayed inside the band.");
    expect(html).not.toContain("Cached");
  });

  it("does not paint the show-more toggle in SSR (overflow is measured client-side)", () => {
    // v1.11.5 — the toggle mounts only on a measured three-line overflow,
    // computed in a layout effect that never runs under SSR, so the
    // server output carries the prose but no toggle. A short assessment
    // that fits never grows a useless affordance.
    const html = render(
      <InsightStatusCard
        {...baseProps}
        text="A short assessment that comfortably fits inside three lines."
      />,
    );
    expect(html).toContain("A short assessment");
    expect(html).not.toContain('data-slot="assessment-show-more"');
  });

  it("renders the structured skeleton (v1.4.37) when loading instead of a centred spinner", () => {
    const html = render(
      <InsightStatusCard {...baseProps} text={null} loading />,
    );
    // The skeleton mounts the same icon dot, title bar, prose lines,
    // and footer that the loaded card paints so the loading state
    // previews the final geometry instead of pinning the card to a
    // single centred spinner row. The aria-busy + sr-only label
    // preserve the accessible "loading" semantics for assistive
    // tech.
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-testid="insight-status-card-loading"');
    expect(html).toContain("Loading");
    // The classic Loader2 + visible "common.loading" copy retired so
    // we do not double-paint the announcement.
    expect(html).not.toContain("animate-spin");
  });

  it("keeps loading, preparing, no-provider, empty, and populated states distinct with stable compact geometry", () => {
    const loading = render(
      <InsightStatusCard {...baseProps} text={null} loading />,
    );
    const preparing = render(
      <InsightStatusCard {...baseProps} text={null} preparing />,
    );
    const noProvider = render(
      <InsightStatusCard {...baseProps} hasProvider={false} text={null} />,
    );
    const empty = render(<InsightStatusCard {...baseProps} text={null} />);
    const populated = render(
      <InsightStatusCard
        {...baseProps}
        text="Pulse stayed inside the expected range."
      />,
    );

    expect(loading).toContain('data-testid="insight-status-card-loading"');
    expect(preparing).toContain('data-testid="insight-status-card-preparing"');
    expect(noProvider).toContain('data-slot="insight-status-no-provider-cta"');
    expect(empty).toContain("No assessment yet.");
    expect(populated).toContain('data-slot="insight-assessment"');

    for (const html of [loading, preparing, noProvider, empty]) {
      expect(html).toContain("gap-2");
      expect(html).toContain("py-3");
      expect(html).toContain("md:py-4");
    }
    expect(populated).toContain("gap-2");
    expect(populated).toContain("space-y-1.5");
    expect(populated).toContain("py-3");
    expect(populated).toContain("md:py-4");
    expect(populated).toContain("text-foreground");
  });
});
