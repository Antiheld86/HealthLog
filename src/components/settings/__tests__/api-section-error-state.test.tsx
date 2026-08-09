/**
 * A read failure on the API-token list must not read as "no active tokens".
 * `useQuery` is forced into its error state; the card has to render the
 * `query-error-card` slot with retry and must never fall through to the empty
 * state — the same §6 fall-through the share-link surface had, on another
 * security surface.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/api",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: true,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ApiSection } from "../api-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ApiSection />
    </I18nProvider>,
  );
}

describe("ApiSection — a token-read failure is honest, not empty", () => {
  it("renders the query-error card with retry and never the empty state", () => {
    const html = render();
    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain('data-slot="query-error-retry"');
    expect(html).not.toContain('data-testid="settings-api-tokens-active-empty"');
    expect(html).not.toContain("No active tokens");
  });
});
