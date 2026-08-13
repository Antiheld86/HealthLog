/**
 * Bottom-nav primary-slot module gate — the MOUNTED contract.
 *
 * `useMounted` is mocked true here, so the resolved module map applies
 * (the sibling `bottom-nav.test.tsx` pins the fail-closed pre-mount
 * markup). The Meds slot pins to `/medications`, whose page renders
 * nothing when the medications module is off — a visible tab over a
 * blank page — so the slot must honour the same per-user map the
 * Insights slot and the More hub already do.
 *
 * Watched red: with the `requiresModule: "medications"` entry removed
 * from PRIMARY_LEFT (the pre-fix ungated pin) the module-off test fails
 * with the tab still present. Verified red against the pre-fix bar.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Mounted=true: the SSR render below behaves like the hydrated bar.
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));

const mockUserRef = {
  value: { id: "u1", modules: {} } as {
    id: string;
    modules: Record<string, boolean>;
  } | null,
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mockUserRef.value,
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n/context";
import { BottomNav } from "../bottom-nav";

function render() {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <BottomNav />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<BottomNav> mounted module gate", () => {
  it("shows the Meds and Insights slots when their modules are on (default-on map)", () => {
    mockUserRef.value = { id: "u1", modules: {} };
    const html = render();
    for (const href of ["/", "/medications", "/insights"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("drops the Meds slot when the medications module is off", () => {
    mockUserRef.value = { id: "u1", modules: { medications: false } };
    const html = render();
    expect(html).not.toContain('href="/medications"');
    // Siblings unaffected.
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/insights"');
    mockUserRef.value = { id: "u1", modules: {} };
  });
});
