/**
 * Bottom-nav iOS-parity layout (additive middle-path).
 *
 * SSR contract for `<BottomNav>`:
 *   - the mobile bar is Home · Meds · Log(center) · Insights · More
 *   - the center "Log" slot is a capture ACTION (a `<button>` with
 *     `aria-haspopup="dialog"`), not a navigation link
 *   - the More button opens a hub (closed by default under SSR)
 *   - the More hub is a real hub: Measurements + Mood (which left the
 *     always-visible strip) stay reachable here, alongside Achievements,
 *     Notifications and Settings — nothing is orphaned (v1.18.0 — Workouts
 *     and Recovery left the nav for their Insights pills)
 *   - WCAG 2.5.5 floor: every strip entry is `min-h-11 min-w-11`
 *
 * v1.8.6 — the Targets (Zielwerte) page is deprecated and dropped from
 * the menu, so it no longer appears in the strip or the hub.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// `<BottomNav>` reads the active route from `usePathname()`. Stub
// next/navigation so the SSR render works without an App-Router runtime.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// v1.18.0 — `<BottomNav>` reads the resolved per-user module map from
// `useAuth()` to gate the hub entries (cycle is the delegated `cycle` key).
// Each test mutates `mockUserRef.value` before rendering.
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
    // The nav reads `useQueryClient()` for the medications intent
    // prefetch (v1.16.7); a fresh client per render keeps the SSR
    // markup assertions isolated.
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <BottomNav />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<BottomNav> iOS-parity layout", () => {
  it("renders the always-on Home anchor", () => {
    const html = render();
    // Home is the one ungated primary slot, so it anchors the strip on
    // first paint. Meds and Insights are BOTH module-gated now and follow
    // the fail-closed-pre-mount contract; their mounted presence is pinned
    // in bottom-nav-module-gate.test.tsx.
    expect(html).toContain('href="/"');
  });

  it("keeps the module-gated Meds and Insights slots OUT of the first-paint markup (v1.25.12)", () => {
    const html = render();
    // Pre-hydration the module map isn't settled; a module-gated primary
    // slot therefore fails closed (absent) rather than flickering in.
    expect(html).not.toContain('href="/insights"');
    expect(html).not.toContain('href="/medications"');
  });

  it("renders the center capture action as a dialog-opening button, not a link", () => {
    const html = render();
    expect(html).toContain('data-testid="bottom-nav-capture"');
    // The capture button opening tag carries aria-haspopup="dialog".
    const capture = html.match(/<button[^>]*bottom-nav-capture[^>]*>/);
    expect(capture).not.toBeNull();
    expect(capture![0]).toMatch(/aria-haspopup="dialog"/);
  });

  it("renders an overflow More button via aria-haspopup", () => {
    const html = render();
    expect(html).toContain('data-testid="bottom-nav-more"');
    expect(html).toMatch(/aria-haspopup="dialog"/);
    expect(html).toMatch(/aria-expanded="false"/);
  });

  it("does not render Measurements or Mood as always-visible strip links", () => {
    // Measurements + Mood left the always-visible strip when the center
    // capture action took the middle slot; they live in the More hub
    // (rendered on open — exercised in e2e) plus the capture picker.
    // The closed-hub SSR markup must therefore carry neither as a strip
    // anchor, and the capture/More affordances replace them.
    const html = render();
    expect(html).not.toContain('href="/measurements"');
    expect(html).not.toContain('href="/mood"');
    // The replacements that keep those surfaces reachable are present.
    expect(html).toContain('data-testid="bottom-nav-capture"');
    expect(html).toContain('data-testid="bottom-nav-more"');
  });

  it("each strip entry meets the 44 px tap-target floor (min-h-11 min-w-11)", () => {
    const html = render();
    // The flanking strip slots carry `min-h-11 min-w-11`. On first paint
    // BOTH module-gated slots (Meds, Insights) are fail-closed (v1.25.12),
    // so the strip shows Home and More — two slots. We don't hard-pin the
    // count because the mounted render adds the gated slots back and a
    // future entry would also satisfy the contract.
    const matches = html.match(/min-h-11 min-w-11/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("the center capture FAB is a larger, elevated tap target", () => {
    const html = render();
    // The FAB clears the 44px floor with a 56px (h-14 w-14) target and
    // is lifted out of the bar (negative top margin + card ring + raised
    // shadow) so it reads as the primary CTA, not a flush fifth tab.
    const capture = html.match(/<button[^>]*bottom-nav-capture[^>]*>/);
    expect(capture).not.toBeNull();
    expect(capture![0]).toMatch(/h-14 w-14/);
    expect(capture![0]).toMatch(/-mt-5/);
    expect(capture![0]).toMatch(/ring-4/);
    expect(capture![0]).toMatch(/shadow-lg/);
  });

  it("no longer lists the deprecated /targets entry (v1.8.6)", () => {
    const html = render();
    expect(html).not.toContain('href="/targets"');
  });

  it("More button carries an accessible label", () => {
    const html = render();
    const hasLabelFirst =
      /aria-label="More"[^>]*data-testid="bottom-nav-more"/.test(html);
    const hasTestidFirst =
      /data-testid="bottom-nav-more"[^>]*aria-label="More"/.test(html);
    expect(hasLabelFirst || hasTestidFirst).toBe(true);
  });

  it("keeps the cycle hub entry out of the closed-hub strip when its module is off", () => {
    mockUserRef.value = { id: "u1", modules: { cycle: false } };
    const html = render();
    // Like Measurements / Mood, the cycle entry lives in the More hub
    // (rendered on open — exercised in e2e), never an always-visible strip.
    expect(html).not.toContain('href="/cycle"');
  });

  it("renders without error when the cycle module is on (entry rides the More hub)", () => {
    mockUserRef.value = { id: "u1", modules: { cycle: true } };
    // The closed-hub SSR markup carries no hub items either way; this guards
    // that gating on the module map never throws.
    expect(() => render()).not.toThrow();
    mockUserRef.value = { id: "u1", modules: {} };
  });

  it("drops the Insights primary slot when the insights module is off (v1.18.0)", () => {
    // The Insights slot is a fixed primary anchor, but it is now
    // module-gated: a disabled insights module must remove it from the
    // strip (and it is excluded from the More hub by the primary-slot
    // filter, so the module is hidden everywhere, not relocated).
    mockUserRef.value = { id: "u1", modules: { insights: false } };
    const html = render();
    expect(html).not.toContain('href="/insights"');
    // The ungated sibling anchor is unaffected.
    expect(html).toContain('href="/"');
    mockUserRef.value = { id: "u1", modules: {} };
  });

  it("still fails the Insights slot closed on first paint even when the module is on (v1.25.12)", () => {
    // Pre-hydration the slot is fail-closed regardless of the map, so the
    // disabled-module flicker cannot occur. The mounted render restores the
    // slot when the module is on (the resolved set is the pure
    // `mobileMoreHubDestinations(..., mounted: true)` contract in
    // nav-model.test.ts, plus the e2e mounted render).
    mockUserRef.value = { id: "u1", modules: { insights: true } };
    const html = render();
    expect(html).not.toContain('href="/insights"');
    mockUserRef.value = { id: "u1", modules: {} };
  });

  it("gating on a disabled module never throws (v1.18.0)", () => {
    mockUserRef.value = {
      id: "u1",
      modules: { mood: false, labs: false, coach: false, achievements: false },
    };
    expect(() => render()).not.toThrow();
    mockUserRef.value = { id: "u1", modules: {} };
  });
});
