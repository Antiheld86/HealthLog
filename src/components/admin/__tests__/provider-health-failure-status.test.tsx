import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * The provider-health card and the HTTP status of the last failure.
 *
 * The ledger has recorded a status on every failure since v1.11.0 and no
 * surface read it, so the card could say a provider was failing without
 * saying whose problem it was. A 401 is a credential the operator has to
 * replace; a 503 is the provider's afternoon. These pin that the status
 * reaches the row, that it is left out when there was none to record,
 * and that a healthy provider does not carry a stale one.
 */

const mockQueryState = vi.hoisted(() => ({
  data: null as null | object,
  isPending: false,
  isError: false,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mockQueryState.data,
    isPending: mockQueryState.isPending,
    isError: mockQueryState.isError,
  }),
}));

import { ProviderHealthSection } from "../provider-health-section";

function row(over: Record<string, unknown> = {}) {
  return {
    providerType: "admin-openai",
    tracked: 5,
    failing: 2,
    maxConsecutiveFailures: 4,
    lastOkAt: null,
    lastFailureAt: "2026-08-27T06:00:00.000Z",
    lastFailureStatus: 401,
    ...over,
  };
}

function render(providers: object[]) {
  mockQueryState.data = { providers };
  mockQueryState.isPending = false;
  mockQueryState.isError = false;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ProviderHealthSection />
    </I18nProvider>,
  );
}

describe("<ProviderHealthSection> — the last failure's HTTP status", () => {
  it("names the status beside the failure it belongs to", () => {
    expect(render([row()])).toContain("HTTP 401");
  });

  it("says nothing where the failure never had a status to record", () => {
    expect(render([row({ lastFailureStatus: null })])).not.toContain("HTTP");
  });

  it("carries no status for a provider that is not failing", () => {
    expect(
      render([
        row({ failing: 0, lastFailureAt: null, lastFailureStatus: 500 }),
      ]),
    ).not.toContain("HTTP");
  });
});
