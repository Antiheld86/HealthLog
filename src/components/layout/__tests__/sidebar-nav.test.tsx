import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// `<SidebarNav>` reads the active route from `usePathname()`. Stub
// next/navigation so the SSR test render works without an App-Router
// runtime.
const mockPathnameRef = { value: "/" };
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathnameRef.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Each test mutates `mockUserRef.value.role` before rendering so we can
// exercise both regular-user and admin layouts from the same suite.
const mockUserRef = {
  value: {
    id: "u1",
    username: "testuser",
    email: "user@example.com",
    role: "USER" as "USER" | "ADMIN",
    avatarUrl: null,
    // v1.18.0 — nav gating reads the resolved per-user module map; cycle is
    // the delegated `cycle` key on it (no bespoke boolean). An absent key
    // fails open (entry shows), matching the gate's default-on contract.
    modules: {} as Record<string, boolean>,
  },
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mockUserRef.value,
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
import { SidebarNav } from "../sidebar-nav";
import { ADMIN_SECTIONS } from "@/components/admin/admin-shell";
import { visibleUtilityDestinations } from "../nav-model";

function render({
  pathname = "/",
  role = "USER" as "USER" | "ADMIN",
  modules = {} as Record<string, boolean>,
}: {
  pathname?: string;
  role?: "USER" | "ADMIN";
  modules?: Record<string, boolean>;
} = {}) {
  mockPathnameRef.value = pathname;
  mockUserRef.value = { ...mockUserRef.value, role, modules };
  return renderToStaticMarkup(
    // The nav reads `useQueryClient()` for the medications intent
    // prefetch (v1.16.7); a fresh client per render keeps the SSR
    // markup assertions isolated.
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <SidebarNav />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// v1.25.12 — these suites render the FIRST-PAINT (pre-hydration) markup.
// `renderToStaticMarkup` drives `useMounted()` to its server snapshot
// (`false`), so the sidebar applies its fail-CLOSED gate: only CORE
// (non-module-gated) destinations render and EVERY module-gated entry is
// absent regardless of the module map. This is the fix for the disabled-
// module flicker — a gated entry can no longer paint for one frame before the
// `/api/auth/me` query resolves. The resolved, post-mount visible set
// ("cycle shows when its module is on", "a disabled module drops out") is the
// pure `visibleNavDestinations(modules, true)` contract verified in
// `nav-model.test.ts`; the mounted render is exercised in e2e.

// CORE destinations carry no `requiresModule` and always render.
const CORE_HREFS = ["/", "/measurements", "/checkups"] as const;
// A representative slice of the module-gated entries that must stay out of
// the first-paint markup whatever the module map says.
const GATED_HREFS = [
  "/mood",
  "/cycle",
  "/medications",
  "/labs",
  "/illness",
  "/insights",
  "/coach",
  "/achievements",
] as const;

describe("<SidebarNav> first-paint fail-closed module gate (v1.25.12)", () => {
  it("renders core destinations on first paint regardless of the module map", () => {
    const maps: Record<string, boolean>[] = [
      {},
      { cycle: true, mood: true, labs: true, coach: true },
      { cycle: false, mood: false },
    ];
    for (const modules of maps) {
      const html = render({ modules });
      for (const href of CORE_HREFS) {
        expect(html).toContain(`href="${href}"`);
      }
    }
  });

  it("keeps every module-gated entry OUT of the first-paint markup, even when its module is enabled", () => {
    // The flicker bug: a gated entry painted before the module query
    // resolved. Pre-mount it must be absent even with the module turned on.
    const html = render({
      modules: {
        cycle: true,
        mood: true,
        labs: true,
        coach: true,
        achievements: true,
        insights: true,
      },
    });
    for (const href of GATED_HREFS) {
      expect(html).not.toContain(`href="${href}"`);
    }
  });

  it("keeps gated entries out when the module map is empty (no fail-open flicker)", () => {
    const html = render({ modules: {} });
    for (const href of GATED_HREFS) {
      expect(html).not.toContain(`href="${href}"`);
    }
  });

  it("keeps gated entries out when the module is explicitly disabled", () => {
    const html = render({
      modules: { mood: false, labs: false, coach: false, achievements: false },
    });
    for (const href of GATED_HREFS) {
      expect(html).not.toContain(`href="${href}"`);
    }
  });

  it("does not render the deprecated /insights/workouts sub-link", () => {
    const html = render();
    expect(html).not.toContain('href="/insights/workouts"');
  });
});

describe("<SidebarNav> targets deprecation (v1.8.6)", () => {
  it("no longer renders the deprecated /targets entry", () => {
    // The Targets (Zielwerte) page is deprecated; target editing moved
    // inline into Insights, so the sidebar drops the entry. Assert absence
    // against a stable CORE sibling that renders on first paint
    // (Measurements stays; Insights is module-gated and pre-mount absent).
    const html = render();
    expect(html).not.toContain('href="/targets"');
    expect(html).toContain('href="/measurements"');
  });
});

describe("<SidebarNav> shared utility tail (v1.17.1 N-1 parity guard)", () => {
  // The footer renders the shared utility tail EXCEPT Notifications, which
  // lives in the avatar dropdown (a Radix menu that is collapsed — and so
  // not in the SSR markup — until opened). The footer-visible utilities are
  // therefore the shared list minus `/notifications`. Asserting they all
  // render straight from the shared list is the parity net that keeps the
  // sidebar footer from drifting away from the mobile More-hub tail.
  const footerUtilities = () =>
    visibleUtilityDestinations().filter((d) => d.href !== "/notifications");

  it("renders every footer utility destination straight from the shared list", () => {
    const html = render();
    for (const dest of footerUtilities()) {
      expect(html).toContain(`href="${dest.href}"`);
    }
    // Settings is the footer utility entry; it is present.
    expect(html).toContain('href="/settings/account"');
  });
});

describe("<SidebarNav> admin entry mirrors Settings (no sub-item expansion)", () => {
  // v1.4.16 A1: the maintainer reported the global sidebar expanding admin
  // sub-items on `/admin/*` was unwanted UX — the in-shell `<AdminShell>`
  // already provides per-section nav inside the page. The Admin entry
  // must behave EXACTLY like the Settings entry: a single link with no
  // sub-list at any route, regardless of where the avatar dropdown is.

  it("does not render admin entries at all for a regular user", () => {
    const html = render({ role: "USER", pathname: "/admin/system-status" });
    expect(html).not.toContain('href="/admin"');
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("for an admin off /admin/* shows a single Admin link without sub-items", () => {
    const html = render({ role: "ADMIN", pathname: "/" });
    expect(html).toContain('href="/admin"');
    // No sub-route links — sidebar collapses into a single Admin entry.
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("for an admin on /admin/* still shows ONLY the single Admin link (no sub-list)", () => {
    const html = render({ role: "ADMIN", pathname: "/admin/system-status" });
    expect(html).toContain('href="/admin"');
    // Sub-section links must NOT appear in the global sidebar — they
    // belong to `<AdminShell>`'s in-page nav. the maintainer reported the
    // expansion as broken UX in v1.4.16; this guard keeps it gone.
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("on the /admin overview page also shows ONLY the single Admin link", () => {
    const html = render({ role: "ADMIN", pathname: "/admin" });
    expect(html).toContain('href="/admin"');
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("Admin entry markup mirrors Settings entry markup (same shape, no expansion)", () => {
    // Both Settings and Admin should render as a single <a> with no
    // adjacent <ul> sub-list. Counting <ul aria-label="Admin sections"
    // (or any descendant ul under the Admin link) confirms there's no
    // disclosure widget. We assert by checking the structural pattern:
    // the Admin link is followed by the Settings link (or the user
    // section), never by a <ul>.
    const html = render({ role: "ADMIN", pathname: "/admin/system-status" });
    // No sub-list <ul> on /admin/*: previously this was the
    // `aria-label={t("admin.shell.sectionsNav")}` ul; assert the only
    // Settings-bearing nav surface is intact (sectionsNav label belongs
    // to `<AdminShell>`, which the sidebar must NOT echo).
    expect(html).not.toMatch(/aria-label="Admin sections"/);
  });
});

describe("<SidebarNav> inside somebody else's record (#939)", () => {
  /**
   * A self-hoster looking after a managed profile could not find Settings
   * anywhere after switching into it, although the Settings shell lists the
   * profile's own configuration there. The footer entry is back wherever the
   * shell has pages for the record, and points at the first of them; the
   * identity block stays a plain block, because it names the person at the
   * keyboard and must not open somebody else's settings under that name.
   *
   * Mutation checks, run:
   *   - `FooterIdentity` always rendering the link → all three switched cases
   *     go red: the managed case on the account-settings label, the adult
   *     MANAGE and READ cases on the identity link's `/settings/account` href;
   *   - the empty tail restored for shared records in
   *     `visibleUtilityDestinations` → both MANAGE cases go red on the missing
   *     Settings link, while the READ case stays green.
   */
  const accountSettingsLabel = (
    JSON.parse(
      readFileSync(join(process.cwd(), "messages/en.json"), "utf8"),
    ) as { nav: { accountSettings: string } }
  ).nav.accountSettings;

  function renderInRecord(
    active: {
      recordKind: "managed" | "shared";
      level: "read" | "write" | "manage";
    } | null,
  ) {
    const user = mockUserRef.value as typeof mockUserRef.value & {
      accountAccess?: unknown;
    };
    user.accountAccess = active
      ? {
          accounts: [],
          canSwitch: true,
          active: {
            accountId: "record-1",
            username: "record",
            displayName: null,
            fullName: null,
            recordKind: active.recordKind,
            level: active.level,
            accessLevel: active.level === "read" ? "read" : "write",
            canWrite: active.level !== "read",
            sections: null,
            writableDomains: [],
            manageableDomains:
              active.level === "manage" ? ["measurements"] : [],
          },
        }
      : undefined;
    try {
      return render();
    } finally {
      delete user.accountAccess;
    }
  }

  const settingsLinks = (html: string) =>
    [...html.matchAll(/<a\b[^>]*data-slot="nav-settings-link"[^>]*>/g)].map(
      (match) => /href="([^"]+)"/.exec(match[0])?.[1],
    );

  it("keeps the account settings door in one's own record", () => {
    const html = renderInRecord(null);
    expect(settingsLinks(html)).toEqual(["/settings/account"]);
    expect(html).toContain(`aria-label="${accountSettingsLabel}"`);
  });

  it("offers Settings inside a managed profile and keeps the identity block a plain block", () => {
    const html = renderInRecord({ recordKind: "managed", level: "manage" });
    expect(settingsLinks(html)).toEqual(["/settings/account"]);
    expect(html).not.toContain(`aria-label="${accountSettingsLabel}"`);
    expect(html).not.toContain('href="/notifications"');
  });

  it("lands an adult MANAGE share on the one Settings page it opens", () => {
    const html = renderInRecord({ recordKind: "shared", level: "manage" });
    expect(settingsLinks(html)).toEqual(["/settings/anamnesis"]);
    expect(html).not.toContain('href="/settings/account"');
  });

  it("offers no Settings entry to a READ share", () => {
    const html = renderInRecord({ recordKind: "shared", level: "read" });
    // Non-zero proof that the sidebar rendered at all.
    expect(html).toContain('href="/measurements"');
    expect(settingsLinks(html)).toEqual([]);
    expect(html).not.toContain('href="/settings/');
  });
});
