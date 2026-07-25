/**
 * v1.17.0 — interaction-parity check for the shared OAuth integration card
 * (Polar / Oura). The new cards must match the existing WHOOP card's
 * parked-state + test-connection + connect→data treatment:
 *
 *   1. A `parked` status renders the warning banner + reconnect button.
 *   2. A `connected` status renders the shared TestConnectionButton (its
 *      "Test connection" affordance) AND the connect→data link.
 *   3. The data link resolves to the provider's insight surface.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Watch } from "lucide-react";

// Drive the card's own `useQuery` status read off a per-test payload.
let statusPayload: unknown = null;
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: statusPayload, isLoading: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { OAuthProviderCard } from "../oauth-provider-card";

function render({
  credentials = false,
  viewModel,
}: {
  credentials?: boolean;
  viewModel?: Parameters<typeof OAuthProviderCard>[0]["viewModel"];
} = {}) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <OAuthProviderCard
        provider="polar"
        statusQueryKey={["polar"]}
        i18nPrefix="settings.polar"
        icon={Watch}
        dataHref="/insights/sleep"
        credentials={credentials}
        viewModel={viewModel}
      />
    </I18nProvider>,
  );
}

describe("OAuthProviderCard — parked + test + data-link parity", () => {
  it("renders the parked banner + reconnect button when state is parked", () => {
    statusPayload = {
      connected: true,
      configured: true,
      available: true,
      state: "parked",
      lastSuccessAt: null,
      lastError: "Polar grant expired",
    };
    const html = render();
    expect(html).toContain('data-state="parked"');
    expect(html).toContain('data-testid="polar-parked-banner"');
    expect(html).toContain('data-testid="polar-resume-button"');
    expect(html).toContain("reconnect manually");
    // The parked banner uses the same warning treatment as the WHOOP card.
    expect(html).toContain("border-warning/30 bg-warning/10");
  });

  it("renders the test-connection button + data link when connected", () => {
    statusPayload = {
      connected: true,
      configured: true,
      available: true,
      state: "connected",
      lastSuccessAt: "2026-06-01T00:00:00.000Z",
      lastError: null,
    };
    const html = render();
    // The shared TestConnectionButton surfaces its "Test connection" label.
    expect(html).toContain("Test connection");
    // connect→data link points at the provider's insight surface.
    expect(html).toContain('data-testid="polar-data-link"');
    expect(html).toContain('href="/insights/sleep"');
  });

  it("reads off the passed view-model instead of the per-card fetch (04-M2)", () => {
    // The per-card useQuery mock returns null; the card must render the
    // connected state from the supplied envelope view-model alone, proving the
    // /api/<provider>/status round-trip is no longer the source.
    statusPayload = null;
    const html = render({
      viewModel: {
        connected: true,
        configured: true,
        available: true,
        state: "connected",
        lastSuccessAt: "2026-06-01T00:00:00.000Z",
        lastError: null,
      },
    });
    expect(html).toContain('data-testid="polar-data-link"');
    expect(html).toContain("Test connection");
  });

  it("does not render the data link or test button when disconnected", () => {
    statusPayload = {
      connected: false,
      configured: false,
      available: true,
    };
    const html = render();
    expect(html).not.toContain('data-testid="polar-data-link"');
    expect(html).not.toContain("Test connection");
    // The connect CTA stands in instead.
    expect(html).toContain('data-testid="polar-connect"');
  });
});

describe("OAuthProviderCard — per-user BYO credentials form (v1.17.1)", () => {
  it("renders the credentials form only when the `credentials` prop is set", () => {
    statusPayload = {
      connected: false,
      configured: false,
      available: true,
      hasOwnCredentials: false,
    };
    // Opt-in: the BYO client-id/secret form + save button appear.
    const withForm = render({ credentials: true });
    expect(withForm).toContain('data-testid="polar-credentials"');
    expect(withForm).toContain('id="polar-clientid"');
    expect(withForm).toContain('id="polar-secret"');

    // Default: no credential inputs (env-only behaviour preserved).
    const withoutForm = render();
    expect(withoutForm).not.toContain('data-testid="polar-credentials"');
    expect(withoutForm).not.toContain('id="polar-clientid"');
  });

  it("shows the saved-placeholder once the user has stored their own pair", () => {
    statusPayload = {
      connected: true,
      configured: true,
      available: true,
      hasOwnCredentials: true,
      state: "connected",
      lastSuccessAt: null,
      lastError: null,
    };
    const html = render({ credentials: true });
    expect(html).toContain("Saved — enter new to replace");
  });
});

describe("OAuthProviderCard — redirect-URI mini-guide (v1.29.x, UX audit H2)", () => {
  it("shows the callback URL guide before the user has BYO credentials", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
    statusPayload = {
      connected: false,
      configured: false,
      available: true,
      hasOwnCredentials: false,
    };
    const html = render({ credentials: true });
    expect(html).toContain('data-testid="polar-redirect-guide"');
    expect(html).toContain('data-testid="polar-redirect-uri"');
    expect(html).toContain("https://app.example/api/polar/callback");
  });

  it("hides the guide once the user has stored their own credentials", () => {
    statusPayload = {
      connected: true,
      configured: true,
      available: true,
      hasOwnCredentials: true,
      state: "connected",
      lastSuccessAt: null,
      lastError: null,
    };
    const html = render({ credentials: true });
    expect(html).not.toContain('data-testid="polar-redirect-guide"');
  });
});

/**
 * v1.32.28 — sync now. The route without the button would be an endpoint with
 * no caller; the button is what makes the manual sync a feature rather than an
 * API detail. Rendered only once the provider is connected, in the same action
 * row as Test connection.
 */
describe("OAuthProviderCard — sync-now action", () => {
  it("offers the sync action on a connected provider", () => {
    statusPayload = {
      connected: true,
      configured: true,
      available: true,
      state: "connected",
      lastSuccessAt: null,
      lastError: null,
    };
    const html = render();
    expect(html).toContain('data-testid="polar-sync"');
    expect(html).toContain("Sync now");
  });

  it("does not offer it before the provider is connected", () => {
    statusPayload = {
      connected: false,
      configured: true,
      available: true,
    };
    expect(render()).not.toContain('data-testid="polar-sync"');
  });
});
