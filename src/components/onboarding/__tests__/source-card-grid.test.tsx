import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.29.x — UX audit H1: the wizard's Withings card must not launch an
 * OAuth handshake that can only 400 for a brand-new account (Withings
 * credentials are per-user BYO with no env fallback). The card reads the
 * consolidated integrations-status envelope and swaps its CTA + href
 * depending on whether the account already has its own credentials saved.
 */

const integrationStatusState = vi.hoisted(() => ({
  data: undefined as
    | {
        threshold: number;
        integrations: Array<{
          integration: string;
          configured?: boolean;
          connected?: boolean;
        }>;
      }
    | undefined,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: integrationStatusState.data }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SourceCardGrid } from "../source-card-grid";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SourceCardGrid />
    </I18nProvider>,
  );
}

describe("<SourceCardGrid> Withings card", () => {
  it("points at Settings instead of launching OAuth when unconfigured", () => {
    integrationStatusState.data = {
      threshold: 3,
      integrations: [{ integration: "withings", configured: false }],
    };
    const html = render();
    expect(html).toContain('data-testid="source-card-withings-setup"');
    expect(html).toContain('href="/settings/integrations#withings"');
    expect(html).not.toContain('href="/api/withings/connect"');
    expect(html).toContain("Set up in Settings");
  });

  it("also redirects to Settings when the status envelope hasn't loaded yet", () => {
    integrationStatusState.data = undefined;
    const html = render();
    expect(html).toContain('href="/settings/integrations#withings"');
    expect(html).not.toContain('href="/api/withings/connect"');
  });

  it("opens the real OAuth connect flow once credentials are configured", () => {
    integrationStatusState.data = {
      threshold: 3,
      integrations: [{ integration: "withings", configured: true }],
    };
    const html = render();
    expect(html).toContain('href="/api/withings/connect"');
    expect(html).not.toContain('data-testid="source-card-withings-setup"');
    expect(html).toContain("Connect Withings");
  });

  // 2026-07-17 UX-onboarding audit M6 — the connect CTA opens OAuth in a
  // new tab; the callback flips the connection in THAT tab while this
  // wizard tab used to render the same unchanged button forever. Once
  // `useIntegrationStatuses` (refetches on window focus) reports
  // `connected: true`, the card must swap to a badge instead of a dead
  // "Connect Withings" button that would just reopen a redundant flow.
  it("shows a connected badge instead of the connect button once Withings is linked", () => {
    integrationStatusState.data = {
      threshold: 3,
      integrations: [
        { integration: "withings", configured: true, connected: true },
      ],
    };
    const html = render();
    expect(html).toContain('data-testid="source-card-withings-connected"');
    expect(html).not.toContain('href="/api/withings/connect"');
    expect(html).not.toContain("Connect Withings");
  });
});

// #778 — the step listed Apple Health next to the web connectors with nothing
// saying its setup happens in the iOS app afterwards, so it read like one more
// OAuth flow to hunt for.
describe("<SourceCardGrid> Apple Health note", () => {
  it("says Apple Health setup completes in the iPhone app, not on the web", () => {
    integrationStatusState.data = undefined;
    const html = render();
    expect(html).toContain('data-testid="source-more-apple-health-note"');
    expect(html).toContain("open the HealthLog app on your iPhone");
    expect(html).toContain("no web connection");
  });

  it("keeps the Apple Health chip tappable so the note is not a dead end", () => {
    integrationStatusState.data = undefined;
    const html = render();
    expect(html).toContain('data-testid="source-more-apple-health"');
    expect(html).toContain('href="/settings/integrations"');
  });
});
