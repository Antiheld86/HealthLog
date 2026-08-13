import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { AiConsentCard } from "../ai-consent-card";

/**
 * The web withdrawal affordance. Before this card the revoke endpoint was
 * reachable only from the native client, so a web-only account could give
 * AI consent and never take it back.
 *
 * These render the card against a pre-seeded query cache (server-side
 * markup, so the mutation path is not exercised here — the endpoint it
 * calls has its own route tests). What they pin is that the card reports
 * the standing decision correctly and offers the withdrawal only when
 * there is something to withdraw.
 */

const receiptKey = ["consent", "ai", "latest", "ai_full"];

function renderWith(receipt: unknown) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(receiptKey, receipt);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <AiConsentCard isAuthenticated />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AiConsentCard", () => {
  it("offers the withdrawal while consent stands", () => {
    const html = renderWith({
      id: "rcpt-1",
      kind: "ai_full",
      signedAt: "2026-07-01T08:00:00.000Z",
      revokedAt: null,
    });

    expect(html).toContain('data-slot="ai-consent-withdraw"');
    expect(html).toContain("Withdraw consent");
  });

  it("reports a withdrawal, stops offering it again, and offers the grant", () => {
    const html = renderWith({
      id: "rcpt-1",
      kind: "ai_full",
      signedAt: "2026-07-01T08:00:00.000Z",
      revokedAt: "2026-07-10T08:00:00.000Z",
    });

    expect(html).toContain("Withdrawn.");
    expect(html).not.toContain('data-slot="ai-consent-withdraw"');
    // Withdrawal must be as reversible as it was easy: the same surface
    // carries the explicit grant control, and its hint says what granting
    // lets the app do.
    expect(html).toContain('data-slot="ai-consent-grant"');
    expect(html).toContain("Grant consent");
  });

  it("treats no receipt at all as consent not given", () => {
    const html = renderWith(null);

    expect(html).toContain("Withdrawn.");
    expect(html).not.toContain('data-slot="ai-consent-withdraw"');
    expect(html).toContain('data-slot="ai-consent-grant"');
  });

  it("never shows the grant control while consent stands", () => {
    const html = renderWith({
      id: "rcpt-1",
      kind: "ai_full",
      signedAt: "2026-07-01T08:00:00.000Z",
      revokedAt: null,
    });

    expect(html).not.toContain('data-slot="ai-consent-grant"');
  });

  it("renders nothing for a signed-out visitor", () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <AiConsentCard isAuthenticated={false} />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(html).toBe("");
  });
});
