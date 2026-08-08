/**
 * Nightscout parity + correctness.
 *
 *   1. A `parked` verdict renders the warning banner + reconnect button
 *      (matching the WHOOP card's parked treatment, byte-for-byte classes).
 *   2. A healthy connection renders the shared TestConnectionButton AND the
 *      connect→data link to /insights/blood-glucose.
 *   3. The card reads the consolidated envelope — it was the last card firing
 *      its own status round-trip — so a disconnect invalidates that one key.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { queryKeys } from "@/lib/query-keys";

// Capture the disconnect mutation's onSuccess so the test can assert which
// query keys it invalidates.
const invalidateSpy = vi.fn();
type OnSuccess = () => void;
const capturedDisconnectOnSuccess: { fn: OnSuccess | null } = { fn: null };

vi.mock("@tanstack/react-query", () => ({
  useMutation: ({ onSuccess }: { onSuccess?: () => void }) => {
    // The Nightscout card declares exactly one mutation (disconnect).
    capturedDisconnectOnSuccess.fn = onSuccess ?? null;
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { NightscoutCard } from "../nightscout-card";
import type { IntegrationStatusViewModel } from "../shared";

function render(viewModel?: Partial<IntegrationStatusViewModel>) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <NightscoutCard
        viewModel={
          viewModel
            ? ({
                integration: "nightscout",
                state: "connected",
                lastSuccessAt: null,
                lastAttemptAt: null,
                lastError: null,
                ...viewModel,
              } as IntegrationStatusViewModel)
            : undefined
        }
      />
    </I18nProvider>,
  );
}

describe("NightscoutCard — parked + test + data-link + invalidation", () => {
  it("renders the parked banner + reconnect button when the verdict is parked", () => {
    const html = render({
      connected: true,
      configured: true,
      state: "parked",
      lastError: "Nightscout unreachable",
      syncHealth: { verdict: "parked", since: null },
    });
    expect(html).toContain('data-state="parked"');
    expect(html).toContain('data-testid="nightscout-parked-banner"');
    expect(html).toContain('data-testid="nightscout-resume-button"');
    expect(html).toContain("border-warning/30 bg-warning/10");
  });

  it("renders the test-connection button + data link when connected", () => {
    const html = render({
      connected: true,
      configured: true,
      lastSuccessAt: "2026-06-01T00:00:00.000Z",
      syncHealth: { verdict: "fresh", since: null },
    });
    expect(html).toContain("Test connection");
    expect(html).toContain('data-testid="nightscout-data-link"');
    expect(html).toContain('href="/insights/blood-glucose"');
  });

  it("carries no card divider — the card gap does that job", () => {
    const html = render({
      connected: true,
      configured: true,
      syncHealth: { verdict: "fresh", since: null },
    });
    expect(html).not.toContain('data-testid="integration-card-divider"');
  });

  it("renders the per-metric freshness disclosure with a stale row", () => {
    const html = render({
      connected: true,
      configured: true,
      syncHealth: { verdict: "fresh", since: null },
      metricFreshness: [
        {
          type: "BLOOD_GLUCOSE",
          lastSeenAt: "2026-06-01T00:00:00.000Z",
          stale: true,
        },
      ],
    });
    expect(html).toContain('data-slot="metric-freshness"');
    expect(html).toContain("quiet");
  });

  it("disconnect invalidates the envelope the card actually reads", () => {
    invalidateSpy.mockClear();
    capturedDisconnectOnSuccess.fn = null;
    render({
      connected: true,
      configured: true,
      syncHealth: { verdict: "fresh", since: null },
    });
    const onSuccess = capturedDisconnectOnSuccess.fn as (() => void) | null;
    expect(typeof onSuccess).toBe("function");
    onSuccess?.();
    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(queryKeys.integrationsStatus());
  });
});

describe("NightscoutCard — sync-now action", () => {
  it("offers the sync action on a connected instance", () => {
    const html = render({
      connected: true,
      configured: true,
      syncHealth: { verdict: "fresh", since: null },
    });
    expect(html).toContain('data-testid="nightscout-sync"');
    expect(html).toContain("Sync now");
  });

  it("does not offer it before an instance is configured", () => {
    expect(
      render({
        connected: false,
        configured: false,
        state: "disconnected",
        syncHealth: { verdict: "disconnected", since: null },
      }),
    ).not.toContain('data-testid="nightscout-sync"');
  });
});

describe("NightscoutCard — operator-owned private access", () => {
  it("does not offer an ordinary user a private-host enforcement bypass", () => {
    const html = render({
      connected: false,
      configured: false,
      state: "disconnected",
      syncHealth: { verdict: "disconnected", since: null },
    });

    expect(html).not.toContain('id="nightscout-private"');
    expect(html).not.toContain("This site runs on a private network");
    expect(html).not.toContain("Enable only if your Nightscout instance");
  });

  it("shows a redacted operator-action state for an unapproved legacy private connection", () => {
    const html = render({
      connected: true,
      configured: true,
      state: "error_reauth",
      lastError:
        "private_origin_not_approved: http://10.0.0.4:1337/api/v1/entries.json?token=ns-secret",
      syncHealth: { verdict: "failing", since: null },
      allowPrivateHost: true,
    });

    expect(html).toContain(
      'data-testid="nightscout-private-operator-required"',
    );
    expect(html).toContain(
      "Private Nightscout access requires server operator approval.",
    );
    expect(html).toContain(
      "Ask your server operator to approve this exact Nightscout origin.",
    );
    expect(html).not.toContain("private_origin_not_approved");
    expect(html).not.toContain("10.0.0.4");
    expect(html).not.toContain("ns-secret");
    expect(html).not.toContain('data-testid="nightscout-sync"');
    expect(html).not.toContain("Test connection");
    expect(html).toContain("Disconnect");
  });

  it.each([
    ["public", false],
    ["operator-approved private", true],
  ])("keeps a healthy %s connection usable", (_label, allowPrivateHost) => {
    const html = render({
      connected: true,
      configured: true,
      state: "connected",
      lastError: null,
      syncHealth: { verdict: "fresh", since: null },
      // Compatibility/display metadata only; it is not the authority asserted
      // by this positive flow.
      allowPrivateHost,
    });

    expect(html).toContain('data-testid="nightscout-sync"');
    expect(html).toContain("Test connection");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain(
      'data-testid="nightscout-private-operator-required"',
    );
  });
});
