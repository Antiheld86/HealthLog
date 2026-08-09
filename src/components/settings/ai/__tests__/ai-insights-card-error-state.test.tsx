/**
 * When the AI settings reads fail, the card must not render the provider form
 * as if it were configured a certain way — a swallowed error there is a lie
 * about the account's provider state. Every read is forced into its error
 * state; the card has to render a `query-error-card` with retry and must not
 * paint the active-provider select.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/ai",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: undefined,
    isError: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { AiInsightsCard } from "../ai-insights-card";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AiInsightsCard isAuthenticated={true} />
    </I18nProvider>,
  );
}

describe("<AiInsightsCard> — a settings-read failure is honest, not a default form", () => {
  it("renders the query-error card with retry and never the provider form", () => {
    const html = render();
    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain('data-slot="query-error-retry"');
    expect(html).not.toContain('data-testid="ai-active-provider-select"');
  });
});
