/**
 * The overview's setup hint closes with an icon button in its header. On a
 * phone it is the only control on the tile a thumb has to hit, so it carries
 * the 44 px floor every other mobile action does (`size-11`), stepping down
 * from `sm` like the rest of the app.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1" }, isAuthenticated: true }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiProviderState: () => ({
    configured: false,
    managedBy: null,
    canConfigure: true,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { AiSetupHint } from "../ai-setup-hint";

function dismissButton(): string {
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: () => undefined },
  });
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AiSetupHint surface="insights" />
    </I18nProvider>,
  );
  vi.unstubAllGlobals();
  const match = html.match(
    /<button[^>]*data-slot="ai-setup-hint-dismiss"[^>]*>/,
  );
  expect(match).not.toBeNull();
  return match![0];
}

describe("the setup hint's dismiss button", () => {
  it("is at least 44 px on a phone", () => {
    const button = dismissButton();
    const cls = button.match(/class="([^"]*)"/)![1]!.split(/\s+/);
    expect(cls).toContain("size-11");
  });
});
