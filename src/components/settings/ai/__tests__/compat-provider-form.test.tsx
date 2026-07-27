import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { CompatProviderForm } from "../compat-provider-form";
import {
  PROVIDER_TYPES,
  DEFAULT_CHAIN,
  uiToLegacyProviderEnum,
  type UserAIProvider,
} from "../shared";

/**
 * The gateway provider has to be reachable from the UI, not only from the
 * resolver — #470's whole complaint was that the combination existed nowhere
 * a user could configure it. These pin that it is offered in the picker, that
 * its form seeds from the saved values, and that a saved bearer is reported
 * as presence rather than echoed.
 */

function baseProvider(overrides: Partial<UserAIProvider>): UserAIProvider {
  return {
    provider: "OPENAI_COMPATIBLE",
    model: null,
    baseUrl: null,
    hasAnthropicKey: false,
    anthropicKeyPreview: null,
    hasLocalKey: false,
    hasOpenaiKey: false,
    openaiKeyPreview: null,
    compatBaseUrl: null,
    compatModel: null,
    hasCompatKey: false,
    responseTimeoutSeconds: null,
    ...overrides,
  };
}

function render(userProvider: UserAIProvider | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <CompatProviderForm userProvider={userProvider} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("the gateway is offered in the provider picker", () => {
  it("appears among the selectable provider types", () => {
    expect(PROVIDER_TYPES).toContain("openai-compatible");
  });

  it("is not in the chain a user starts with", () => {
    expect(DEFAULT_CHAIN.map((entry) => entry.providerType)).not.toContain(
      "openai-compatible",
    );
  });

  it("maps onto its own persisted provider value", () => {
    expect(uiToLegacyProviderEnum("openai-compatible")).toBe(
      "OPENAI_COMPATIBLE",
    );
  });
});

describe("CompatProviderForm", () => {
  it("seeds the saved base URL and model", () => {
    const html = render(
      baseProvider({
        compatBaseUrl: "https://litellm.example.com/v1",
        compatModel: "anthropic/claude-sonnet-4-6",
      }),
    );
    expect(html).toContain('value="https://litellm.example.com/v1"');
    expect(html).toContain('value="anthropic/claude-sonnet-4-6"');
  });

  it("reports a stored bearer as presence, never as a value", () => {
    const html = render(
      baseProvider({
        compatBaseUrl: "https://litellm.example.com/v1",
        compatModel: "m",
        hasCompatKey: true,
      }),
    );
    // The key input is empty and only its placeholder says one is stored.
    expect(html).toContain('placeholder="(saved)"');
  });

  it("renders empty for a user who has configured nothing", () => {
    const html = render(baseProvider({}));
    expect(html).toContain('id="ai-compat-base-url"');
    expect(html).toContain('id="ai-compat-model"');
    expect(html).toContain('id="ai-compat-key"');
  });
});
