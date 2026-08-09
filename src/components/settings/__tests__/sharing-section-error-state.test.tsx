/**
 * A read failure on the owner share-link surface must not read as "no active
 * links". `useQuery` is forced into its error state; the card has to render the
 * `query-error-card` slot with a retry affordance and must never fall through
 * to the empty-state copy — that fall-through is the §6-forbidden case a
 * clinical sharing surface cannot afford (a failed read is indistinguishable
 * from "you have shared nothing").
 *
 * SSR-static render, matching the sibling sharing-section test.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: undefined,
    isError: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SharingSection } from "../sharing-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SharingSection />
    </I18nProvider>,
  );
}

describe("<SharingSection> — a read failure is honest, not empty", () => {
  it("renders the query-error card with retry and never the empty state", () => {
    const html = render();
    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain('data-slot="query-error-retry"');
    // The empty-state must not appear: a failed read is not "no active links".
    expect(html).not.toContain('data-testid="share-active-empty"');
    expect(html).not.toContain("No active share links");
  });
});
