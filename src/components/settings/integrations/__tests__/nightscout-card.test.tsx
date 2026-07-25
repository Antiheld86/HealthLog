/**
 * v1.17.0 — interaction-parity + correctness checks for the Nightscout card.
 *
 *   1. A `parked` status renders the warning banner + reconnect button
 *      (matching the WHOOP card's parked treatment, byte-for-byte classes).
 *   2. A `connected` status renders the shared TestConnectionButton AND the
 *      connect→data link to /insights/blood-glucose.
 *   3. The disconnect mutation invalidates `nightscoutStatus()` — the key the
 *      status query actually reads — so the pill refreshes after disconnect.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { queryKeys } from "@/lib/query-keys";

// Capture the disconnect mutation's onSuccess so the test can assert which
// query keys it invalidates. Status is driven off a per-test payload.
let statusPayload: unknown = null;
const invalidateSpy = vi.fn();
type OnSuccess = () => void;
const capturedDisconnectOnSuccess: { fn: OnSuccess | null } = { fn: null };

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: statusPayload, isLoading: false }),
  useMutation: ({ onSuccess }: { onSuccess?: () => void }) => {
    // The Nightscout card declares exactly one mutation (disconnect).
    capturedDisconnectOnSuccess.fn = onSuccess ?? null;
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { NightscoutCard } from "../nightscout-card";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <NightscoutCard />
    </I18nProvider>,
  );
}

describe("NightscoutCard — parked + test + data-link + invalidation", () => {
  it("renders the parked banner + reconnect button when state is parked", () => {
    statusPayload = {
      connected: true,
      configured: true,
      state: "parked",
      lastSuccessAt: null,
      lastError: "Nightscout unreachable",
    };
    const html = render();
    expect(html).toContain('data-state="parked"');
    expect(html).toContain('data-testid="nightscout-parked-banner"');
    expect(html).toContain('data-testid="nightscout-resume-button"');
    expect(html).toContain("border-warning/30 bg-warning/10");
  });

  it("renders the test-connection button + data link when connected", () => {
    statusPayload = {
      connected: true,
      configured: true,
      state: "connected",
      lastSuccessAt: "2026-06-01T00:00:00.000Z",
      lastError: null,
    };
    const html = render();
    expect(html).toContain("Test connection");
    expect(html).toContain('data-testid="nightscout-data-link"');
    expect(html).toContain('href="/insights/blood-glucose"');
  });

  it("disconnect invalidates the status key the query reads (nightscoutStatus)", () => {
    statusPayload = { connected: true, configured: true, state: "connected" };
    invalidateSpy.mockClear();
    capturedDisconnectOnSuccess.fn = null;
    render();
    const onSuccess = capturedDisconnectOnSuccess.fn as (() => void) | null;
    expect(typeof onSuccess).toBe("function");
    onSuccess?.();
    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(queryKeys.nightscoutStatus());
  });
});

/**
 * v1.32.28 — sync now, matching the treatment the OAuth cards get.
 */
describe("NightscoutCard — sync-now action", () => {
  it("offers the sync action on a connected instance", () => {
    statusPayload = {
      connected: true,
      configured: true,
      state: "connected",
      lastSuccessAt: null,
      lastError: null,
    };
    const html = render();
    expect(html).toContain('data-testid="nightscout-sync"');
    expect(html).toContain("Sync now");
  });

  it("does not offer it before an instance is configured", () => {
    statusPayload = { connected: false, configured: false };
    expect(render()).not.toContain('data-testid="nightscout-sync"');
  });
});
