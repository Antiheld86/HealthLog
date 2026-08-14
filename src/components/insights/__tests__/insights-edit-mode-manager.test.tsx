import React from "react";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InsightsEditMode } from "../insights-edit-mode";
import {
  DEFAULT_INSIGHTS_LAYOUT,
  type InsightsSectionId,
} from "@/lib/insights-layout";

function render(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<InsightsEditMode> — detail-page manager retired (v1.15.20)", () => {
  const noneGated: ReadonlySet<InsightsSectionId> = new Set();

  function renderEditMode(): string {
    return render(
      <InsightsEditMode
        layout={DEFAULT_INSIGHTS_LAYOUT}
        gatedOffSectionIds={noneGated}
        onClose={() => {}}
      />,
    );
  }

  it("no longer renders the per-detail-page manager disclosure", () => {
    // Pill sorting + visibility moved to Settings → Insights; the in-card
    // disclosure under the Vitals row duplicated that surface.
    const html = renderEditMode();
    expect(html).not.toContain('data-slot="insights-edit-tiles-disclosure"');
    expect(html).not.toContain('data-slot="insights-edit-tile-row"');
    expect(html).not.toContain('data-slot="insights-edit-tiles-nav-hint"');
  });

  it("links to the settings pill section instead", () => {
    const html = renderEditMode();
    expect(html).toContain('data-slot="insights-edit-manage-link"');
    expect(html).toContain(
      'href="/settings/layout/insights#insights-pill-order"',
    );
    expect(html).toContain("Manage chips &amp; detail pages in Settings");
  });

  it("still renders the section rows with their eye toggles", () => {
    const html = renderEditMode();
    expect(html).toContain('data-slot="insights-edit-section-row"');
    expect(html).toContain('data-slot="insights-edit-section-eye"');
  });
});
