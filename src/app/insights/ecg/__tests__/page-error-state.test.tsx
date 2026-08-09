/**
 * A failed ECG-list read on the routed `/insights/ecg` page must not leave the
 * shell heading over an empty body — indistinguishable from "still loading".
 * The shared list query is forced into its error state; the page has to render
 * a `query-error-card` with retry inside the shell.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: true,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import InsightsEcgPage from "../page";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <InsightsEcgPage />
    </I18nProvider>,
  );
}

describe("/insights/ecg page — a read failure is honest, not an empty shell", () => {
  it("renders the query-error card with retry, not an empty section body", () => {
    const html = render();
    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain('data-slot="query-error-retry"');
    // The heading shell is still there, but not over a silently empty body.
    expect(html).toContain('id="insights-subpage-title"');
  });
});
