/**
 * v1.4.47 W3 — Settings → Coach activation toggle persistence contract.
 *
 * v1.18.1 (D7) — the card reads "Activate Coach" (default ON). The persisted
 * column is still `User.disableCoach`; the Switch shows the activated view
 * (`checked = !disableCoach`). The SSR render is `mounted=false`, where the
 * card paints the default-ON (checked) state so the default-on contract holds
 * before the wire value resolves — both default and opted-out users render
 * checked under `renderToStaticMarkup`.
 *
 * The card is a small client-only `<Switch>` that PATCHes
 * `/api/auth/me/disable-coach` and invalidates `queryKeys.authMe()` so
 * every Coach mount point in the app reacts on the next /me refetch.
 *
 * Test strategy: use the real `useMutation` + `QueryClient` from
 * `@tanstack/react-query`, stub `fetch`, and drive the Switch via a
 * `renderToStaticMarkup` pass plus a hand-invoked mutation call. The
 * file SSR-renders inside a `<QueryClientProvider>` so the hook
 * branches execute and the spies fire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { AuthUser } from "@/hooks/use-auth";

const authSpy = vi.fn<
  () => { user: AuthUser | null; isAuthenticated: boolean }
>(() => ({ user: buildUser(false), isAuthenticated: true }));
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return {
    ...actual,
    useAuth: () => authSpy(),
  };
});

// Stub the navigation hooks the parent `<CoachSection>` (and its child
// cards) reach for so the SSR pass doesn't blow up. The disable-coach card
// itself doesn't trigger any GET — it only writes through PATCH on click.
//
// v1.18.0 (S5) — the Coach cards moved from `<AiSection>` to the dedicated
// `<CoachSection>`; this contract test renders the new parent.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/coach",
  useSearchParams: () => new URLSearchParams(""),
}));

function buildUser(disableCoach: boolean): AuthUser {
  return {
    id: "user-1",
    username: "testuser",
    email: null,
    role: "USER",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "Europe/Berlin",
    onboardingCompletedAt: null,
    onboardingTourCompleted: true,
    onboardingTourProgress: null,
    avatarUrl: null,
    glucoseUnit: null,
    unitPreference: "metric",
    timeFormat: "AUTO",
    dateFormat: "AUTO",
    disableCoach,
    fullName: null,
    insurerName: null,
    insurerIkNumber: null,
    insuranceNumber: null,
    lastReportPracticeName: null,
    reportSelection: null,
    cycleTrackingEnabled: false,
    modules: {},
  };
}

import { CoachSection } from "../coach-section";

function makeFetch() {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    return new Response(
      JSON.stringify({
        data: { disableCoach: body.disableCoach ?? false },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
}

beforeEach(() => {
  authSpy.mockClear();
  authSpy.mockImplementation(() => ({
    user: buildUser(false),
    isAuthenticated: true,
  }));
  vi.stubGlobal("fetch", makeFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <CoachSection />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Settings — DisableCoachCard", () => {
  it("renders the activation Switch checked at SSR (default-on contract)", () => {
    const html = render();
    // v1.18.1 (D7) — the SSR render is `mounted=false`, where the card paints
    // the default-ON (activated → checked) state regardless of the wire value,
    // so the Switch never flashes off before /me resolves.
    expect(html).toContain('data-testid="settings-disable-coach-switch"');
    expect(html).toContain('data-state="checked"');
  });

  it("paints the activated (checked) SSR state even for an opted-out user", () => {
    authSpy.mockImplementation(() => ({
      user: buildUser(true),
      isAuthenticated: true,
    }));
    const html = render();
    expect(html).toContain('data-testid="settings-disable-coach-switch"');
    // The activated state resolves on the first client re-render once
    // `mounted` flips; the SSR pass stays on the default-ON shape.
    expect(html).toContain('data-state="checked"');
  });

  it("renders the Coach-activation title + description", () => {
    const html = render();
    // v1.18.1 (D7) — polarity flipped to activate/default-on.
    expect(html).toContain("Activate Coach");
    expect(html).toContain("Show the Coach button and drawer");
  });
});
