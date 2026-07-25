/**
 * Nothing on the envelope may render nowhere.
 *
 * A provider whose Settings card was removed kept its cron, its ledger row and
 * its block on the status envelope, and lost the only surface that could have
 * shown it dying. It then stopped syncing for a month and no screen anywhere
 * said so — every audit that went looking worked from the cards, so a provider
 * without a card appeared in no cohort at all.
 *
 * The panel's unit of coverage is therefore the envelope entry, not the card.
 * This is the acceptance test in executable form: render the panel with an
 * envelope carrying every integration key, and require that each configured
 * one surfaces either as a bespoke card or as a fallback row.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/integrations",
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

let envelope: unknown = null;
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = Array.isArray(queryKey) ? queryKey.join("/") : "";
    if (key === "integrations/status") {
      return { data: envelope, isLoading: false };
    }
    return { data: null, isLoading: false, isError: false, refetch: vi.fn() };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ConnectionsPanel } from "../connections-panel";
import { INTEGRATION_DISPLAY_NAMES } from "../integration-fallback-row";

const MONTH_AGO = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

/** Every key the server can ship, all configured, all a month silent. */
function fullEnvelope() {
  return {
    threshold: 3,
    integrations: Object.keys(INTEGRATION_DISPLAY_NAMES).map((integration) => ({
      integration,
      state: "error_transient",
      lastSuccessAt: MONTH_AGO,
      lastAttemptAt: MONTH_AGO,
      lastError: null,
      configured: true,
      connected: true,
      available: true,
      syncHealth: { verdict: "stalled", since: MONTH_AGO },
      metricFreshness: [],
    })),
  };
}

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ConnectionsPanel />
    </I18nProvider>,
  );
}

describe("ConnectionsPanel — every envelope entry surfaces", () => {
  it("renders a card or a fallback row for every configured entry", () => {
    envelope = fullEnvelope();
    const html = render();

    for (const integration of Object.keys(INTEGRATION_DISPLAY_NAMES)) {
      const hasCard = html.includes(`data-testid="${integration}-card"`);
      const hasFallback = html.includes(`data-integration="${integration}"`);
      expect(
        hasCard || hasFallback,
        `${integration} renders nowhere on the connections panel`,
      ).toBe(true);
    }
  });

  it("gives the card-less provider a fallback row with the stalled pill", () => {
    // moodLog is the live case: no card since its removal, still on the wire,
    // still running an hourly cron against an upstream that stopped answering.
    envelope = fullEnvelope();
    const html = render();

    expect(html).toContain('data-testid="integration-fallback-row"');
    expect(html).toContain('data-integration="moodlog"');
    expect(html).toContain("moodLog");
    expect(html).toContain('data-state="stalled"');
    expect(html).toContain("Sync stopped");
    expect(html).toContain("Last attempt");
  });

  it("renders no fallback row for a provider that is not configured", () => {
    // Absence stays absence: an unconfigured provider is not a problem to
    // report, so the panel says nothing about it.
    envelope = {
      threshold: 3,
      integrations: [
        {
          integration: "moodlog",
          state: "disconnected",
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
          configured: false,
          syncHealth: { verdict: "disconnected", since: null },
          metricFreshness: [],
        },
      ],
    };
    expect(render()).not.toContain('data-testid="integration-fallback-row"');
  });
});
