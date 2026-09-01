/**
 * v1.29.x — UX audit H2: the WHOOP card shows a compact callback-URL guide
 * while the account has no BYO credentials saved, and steps out of the way
 * once configured. Mirrors the OAuthProviderCard coverage for Polar/Oura.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { WhoopCard } from "../whoop-card";
import type { IntegrationStatusViewModel } from "../shared";

function render(
  viewModel?: Partial<IntegrationStatusViewModel>,
  callbackUrl: string | null = "https://app.example/api/whoop/callback",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <WhoopCard
        viewModel={viewModel as IntegrationStatusViewModel | undefined}
        callbackUrl={callbackUrl}
      />
    </I18nProvider>,
  );
}

describe("<WhoopCard> redirect-URI mini-guide", () => {
  it("shows the callback URL guide before credentials are configured", () => {
    const html = render({ connected: false, configured: false });
    expect(html).toContain('data-testid="whoop-redirect-guide"');
    expect(html).toContain('data-testid="whoop-redirect-uri"');
    expect(html).toContain("https://app.example/api/whoop/callback");
  });

  it("falls back to the fixed path when the server has no redirect URI", () => {
    const html = render({ connected: false, configured: false }, null);
    expect(html).toContain('data-testid="whoop-redirect-uri"');
    expect(html).toContain("/api/whoop/callback");
    expect(html).not.toContain("undefined/api/whoop/callback");
  });

  it("hides the guide once credentials are configured", () => {
    const html = render({ connected: false, configured: true });
    expect(html).not.toContain('data-testid="whoop-redirect-guide"');
  });
});
