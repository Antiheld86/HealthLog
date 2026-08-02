/**
 * The top bar and the sidebar logo band draw one continuous line across the
 * top of the app. They are siblings in different columns of the shell flex
 * row, so nothing in the layout makes them agree: the only thing that does is
 * that both read `SHELL_HEADER_BAND` for their height AND their bottom
 * border.
 *
 * This suite asserts the structural property, which is stronger than "the two
 * borders happen to land on the same y today": each band carries every token
 * of the shared constant, and neither band declares a height of its own. A
 * second height class on either element replaces the shared one through
 * `twMerge`, so both halves of the assertion fire on the same mutation.
 *
 * The painted result is measured in `e2e/chrome-header-seam.spec.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "testuser",
      email: "user@example.com",
      role: "USER" as const,
      avatarUrl: null,
      modules: {} as Record<string, boolean>,
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/providers", () => ({
  useTheme: () => ({
    theme: "system" as const,
    resolvedTheme: "dark" as const,
    setTheme: vi.fn(),
  }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n/context";
import { SHELL_HEADER_BAND } from "../shell-metrics";
import { SidebarNav } from "../sidebar-nav";
import { TopBar } from "../top-bar";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

/**
 * Pull the class list off the element carrying `data-slot="<slot>"`. The
 * pattern spans the whole opening tag, so it holds whichever side of
 * `data-slot` React emits the class attribute on.
 */
function classTokens(html: string, slot: string): string[] {
  const tag = new RegExp(`<[a-z]+[^>]*\\bdata-slot="${slot}"[^>]*>`, "i").exec(
    html,
  );
  expect(
    tag,
    `no element with data-slot="${slot}" in the rendered markup`,
  ).not.toBeNull();
  const cls = /\bclass="([^"]*)"/.exec(tag![0]);
  expect(
    cls,
    `the data-slot="${slot}" element carries no class attribute`,
  ).not.toBeNull();
  return cls![1].split(/\s+/).filter(Boolean);
}

const isHeightToken = (t: string) =>
  /^(?:(?:sm|md|lg|xl|2xl):)?(?:min-|max-)?h-/.test(t);

const BAND_TOKENS = SHELL_HEADER_BAND.split(/\s+/).filter(Boolean);
const BAND_HEIGHT_TOKENS = BAND_TOKENS.filter(isHeightToken);

const BANDS: ReadonlyArray<[string, string, () => string]> = [
  ["top bar", "top-bar", () => render(<TopBar />)],
  ["sidebar logo band", "sidebar-header", () => render(<SidebarNav />)],
];

describe("app-chrome header seam", () => {
  it("SHELL_HEADER_BAND declares both a height and a bottom border", () => {
    // The whole point of the constant is that the border ships INSIDE the
    // 4rem box. A constant that carried only the height would let the two
    // call sites put the line on different elements again.
    expect(BAND_HEIGHT_TOKENS.length).toBeGreaterThan(0);
    expect(BAND_TOKENS).toContain("border-b");
  });

  for (const [label, slot, renderBand] of BANDS) {
    it(`${label} takes its height and border from SHELL_HEADER_BAND`, () => {
      const tokens = classTokens(renderBand(), slot);
      for (const token of BAND_TOKENS) {
        expect(
          tokens,
          `the ${label} dropped "${token}" from the shared band`,
        ).toContain(token);
      }
    });

    it(`${label} declares no height of its own`, () => {
      const tokens = classTokens(renderBand(), slot);
      expect(
        tokens.filter(isHeightToken).sort(),
        `the ${label} carries a height class that is not the shared band's`,
      ).toEqual([...BAND_HEIGHT_TOKENS].sort());
    });
  }
});
