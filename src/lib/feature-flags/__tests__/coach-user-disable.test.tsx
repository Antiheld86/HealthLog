import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";
import {
  DEFAULT_ASSISTANT_FLAGS,
  type AssistantFlagSet,
} from "@/hooks/use-feature-flags";
import type { AuthUser } from "@/hooks/use-auth";

import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { LayoutCoachFab } from "@/components/insights/layout-coach-fab";
import { LayoutCoachMount } from "@/components/insights/layout-coach-mount";

/**
 * v1.4.47 W3 — per-user "Hide Coach" opt-out invariant.
 *
 * The Coach disable cascade (`coach-cascade.test.tsx`) pins the
 * operator-level `flags.coach` gate. This sibling fixture pins the
 * per-user `disableCoach` gate that sits BELOW the operator flag —
 * either gate being off must hide every Coach affordance with no
 * grey-out, no error, no inert button, no DOM trace.
 *
 * Mocking strategy mirrors the cascade fixture: spy `useFeatureFlags`
 * to drive the operator matrix synchronously during SSR, spy
 * `useAuth` to drive the per-user `disableCoach` field. Both spies
 * are reset between iterations so a regression in either gate trips
 * the invariant in isolation.
 */

const featureFlagsSpy = vi.fn<() => AssistantFlagSet>(
  () => DEFAULT_ASSISTANT_FLAGS,
);
vi.mock("@/hooks/use-feature-flags", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/use-feature-flags")
  >("@/hooks/use-feature-flags");
  return {
    ...actual,
    useFeatureFlags: () => featureFlagsSpy(),
  };
});

const authSpy = vi.fn<
  () => { user: AuthUser | null; isAuthenticated: boolean }
>(() => ({ user: null, isAuthenticated: false }));
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

// The Coach gates read user.disableCoach through `useDisableCoach`,
// which itself calls `useAuth()`. Mocking `useDisableCoach` directly
// would bypass the useAuth call site and make the spy assertion
// below trivially fail; instead we let the real `useDisableCoach`
// pass through and capture the underlying `useAuth` calls.

// v1.16.1 — the nudge-driven `<LayoutCoachFab>` reads the app router
// (push + pathname); SSR test renders have no router context.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/insights",
}));

function buildUser(disableCoach: boolean): AuthUser {
  // Minimal `AuthUser` shape — the Coach gates only read
  // `disableCoach`, but TypeScript requires the full interface to
  // satisfy the mock's return type. Everything else is filler.
  return {
    id: "test-user-id",
    username: "test",
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

function buildClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
}

function renderWithDisableCoach(
  node: React.ReactNode,
  disableCoach: boolean,
  coach: boolean = true,
): string {
  featureFlagsSpy.mockImplementation(() => ({
    ...DEFAULT_ASSISTANT_FLAGS,
    coach,
  }));
  authSpy.mockImplementation(() => ({
    user: buildUser(disableCoach),
    isAuthenticated: true,
  }));
  const client = buildClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

interface DisableCoachSurface {
  name: string;
  mount: () => React.ReactNode;
  /**
   * Substring that proves the surface painted. Empty string means
   * "the surface SSR-renders to nothing even when on" (lazy-loaded
   * subtrees) and the negative assertion is the dispositive check.
   */
  proofWhenVisible: string;
}

const DISABLE_COACH_SURFACES: DisableCoachSurface[] = [
  {
    name: "LayoutCoachFab",
    mount: () => (
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>
    ),
    // v1.16.1 — nudge-driven: SSR shape is empty even when visible
    // (the bubble waits for the nudge-status query). Negative
    // assertion still pins the gate via the `coach-*` slot grep.
    proofWhenVisible: "",
  },
  {
    name: "LayoutCoachMount",
    mount: () => (
      <CoachLaunchProvider>
        <LayoutCoachMount />
      </CoachLaunchProvider>
    ),
    // Lazy-loaded — SSR shape is empty even when visible. Negative
    // assertion still pins the gate via the `coach-*` slot grep.
    proofWhenVisible: "",
  },
  {
    name: "CoachLaunchButton inline pill",
    mount: () => (
      <CoachLaunchProvider>
        <CoachLaunchButton />
      </CoachLaunchProvider>
    ),
    proofWhenVisible: 'data-slot="coach-launch-inline"',
  },
  // v1.18.7 — the HeroStrip "Ask the coach" action button and the
  // SuggestedPrompts chip strip were removed from the overview hero, and the
  // strip's component has now been deleted with the rest of the unmounted
  // insights cluster. The Coach is the bottom-right drawer; the launcher
  // surfaces above carry the per-user disable gate.
];

describe("Coach per-user disableCoach invariant", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    featureFlagsSpy.mockClear();
    authSpy.mockClear();
    featureFlagsSpy.mockImplementation(() => DEFAULT_ASSISTANT_FLAGS);
    authSpy.mockImplementation(() => ({
      user: buildUser(false),
      isAuthenticated: true,
    }));
  });

  for (const surface of DISABLE_COACH_SURFACES) {
    it(`${surface.name} — paints when user.disableCoach is false`, () => {
      if (!surface.proofWhenVisible) return;
      const html = renderWithDisableCoach(surface.mount(), false);
      expect(html).toContain(surface.proofWhenVisible);
    });

    it(`${surface.name} — vanishes when user.disableCoach is true`, () => {
      const html = renderWithDisableCoach(surface.mount(), true);
      if (surface.proofWhenVisible) {
        expect(html).not.toContain(surface.proofWhenVisible);
      }
      // No Coach-marked mount point may paint when the per-user gate
      // is on. Pin the negative shape against the shared prefix so a
      // future surface that grows a new `coach-*` slot without the
      // disableCoach gate fails this test by default.
      expect(html).not.toMatch(/data-slot="coach-[a-z]/);
      expect(html).not.toContain('data-slot="insights-suggested-prompts"');
      expect(html).not.toContain(
        'data-slot="insights-hero-strip-action-coach"',
      );
      expect(html).not.toContain('data-slot="insights-hero-strip-prompts"');
    });

    it(`${surface.name} — also vanishes when flags.coach is false (regression pin)`, () => {
      // The legacy operator-level gate must keep working in the
      // presence of the new per-user gate. This guards against a
      // regression where a contributor "simplifies" the two checks
      // into one and accidentally drops the operator branch.
      const html = renderWithDisableCoach(surface.mount(), false, false);
      if (surface.proofWhenVisible) {
        expect(html).not.toContain(surface.proofWhenVisible);
      }
      expect(html).not.toMatch(/data-slot="coach-[a-z]/);
    });
  }

  it("`useAuth` gate is consulted on every Coach surface", () => {
    // A `disableCoach: true` render must trip the `useAuth` spy at
    // least once. Otherwise a future regression that drops the
    // `useAuth()` call site silently leaks the affordance.
    for (const surface of DISABLE_COACH_SURFACES) {
      authSpy.mockClear();
      renderWithDisableCoach(surface.mount(), true);
      expect(
        authSpy,
        `${surface.name} did not consult useAuth() during render`,
      ).toHaveBeenCalled();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // v1.4.48 H2 — grep-based discovery of every `useDisableCoach` /
  // `user.disableCoach` call site in the codebase.
  //
  // Mirrors the `flags.coach` discovery walk in `coach-cascade.test.tsx`:
  // the surface fixture above pins the surfaces this file mounts
  // directly. Cross-cut gates (Settings → Insights toggle, `/api/auth/me`
  // response shape, the disable-coach PATCH route) sit OUTSIDE the
  // fixture and are owned by sibling invariants or by route-level tests.
  //
  // The walk below scans `src/` for every `useDisableCoach` /
  // `user.disableCoach` / `user?.disableCoach` occurrence and requires
  // each path to appear in the explicit `KNOWN_DISABLE_COACH_GATE_SITES`
  // allowlist. Add a new entry every time you intentionally read the
  // per-user disable flag in a new path; the failure message names the
  // unaccounted-for paths so the fix is one search-and-add.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Every file in `src/` that legitimately reads `useDisableCoach` or
   * `user.disableCoach`. Lives next to the disable-cascade fixture so a
   * contributor extending the fixture sees the allowlist in the same
   * review.
   *
   * Paths are POSIX-style relative to the repo root.
   */
  const KNOWN_DISABLE_COACH_GATE_SITES: ReadonlyArray<string> = [
    // Coach-bearing surfaces mounted directly by the disable-cascade
    // fixture above; each one calls `useDisableCoach()` and short-
    // circuits to `null` when the per-user flag is on.
    "src/components/insights/coach-launch-button.tsx",
    // v1.21.0 (C4 H2) — the reverse-direction "Ask the Coach about this"
    // card affordance mirrors the launch-button gate: operator master flag
    // OR per-user opt-out short-circuits it to `null` so a card never paints
    // a dead Coach control.
    "src/components/insights/ask-coach-action.tsx",
    // v1.18.7 — hero-strip.tsx no longer gates on the Coach flag: its
    // action button + suggested-prompt strip were removed, so it dropped
    // the `useDisableCoach` call entirely.
    "src/components/insights/layout-coach-fab.tsx",
    "src/components/insights/layout-coach-mount.tsx",
    // v1.12.0 — the full-page Coach route mirrors the launch-button /
    // FAB gate: operator master flag OR per-user opt-out redirects the
    // page back to `/insights` instead of painting a dead chat shell.
    // v1.18.0 — moved to the standalone top-level `/coach` route.
    // v1.30.x — split into an RSC prefetch wrapper (`page.tsx`, which reads
    // `session.user.disableCoach` to skip the nudge prefetch for an opted-out
    // account) + the client leaf (`page-client.tsx`, the `useDisableCoach`
    // render-path gate). Both legitimately read the per-user flag.
    "src/app/coach/page.tsx",
    "src/app/coach/page-client.tsx",
    // v1.21.4 — the dedicated conversation-history page mirrors the
    // Coach route gate: operator master flag OR per-user opt-out marks
    // the page unavailable instead of painting a dead history shell.
    "src/app/coach/conversations/page.tsx",
    // The plans management page mirrors the same gate: operator master
    // flag OR per-user opt-out redirects instead of a dead plans shell.
    "src/app/coach/plans/page.tsx",
    // The hook itself + its `useAuth`-backed reader.
    "src/hooks/use-disable-coach.ts",
    // Cross-cut gates owned by sibling invariants / route tests.
    // - `/api/auth/me` ships the flag in the session payload so the
    //   client hooks can read it (`useAuth → useDisableCoach`). The
    //   sibling `/api/auth/me/disable-coach` PATCH endpoint that
    //   writes the flag does NOT read `user.disableCoach` (it reads
    //   `body.disableCoach`) and is intentionally not listed here.
    "src/app/api/auth/me/route.ts",
    // - Settings → Coach section: the toggle card reads + writes the
    //   flag; the section shell reads it to gate the Coach sub-cards.
    //   v1.18.0 — moved out of the AI/Assistent section into its own
    //   dedicated Coach settings entry.
    "src/components/settings/ai/disable-coach-card.tsx",
    "src/components/settings/coach-section.tsx",
    // v1.7.0 W6 — the unified dashboard snapshot builder reads
    // `user.disableCoach` to gate the embedded daily briefing to
    // `briefingState: "disabled"`. Covered by the briefingState matrix
    // in `src/lib/dashboard/__tests__/snapshot.test.ts`. The shared
    // cached-read helper (used by BOTH the API route and the dashboard
    // RSC prefetch) maps the session user's flag into the builder
    // input; the route itself no longer touches the flag.
    "src/lib/dashboard/snapshot.ts",
    "src/lib/dashboard/snapshot-read.ts",
    // v1.18.0 — the module enable/disable gate delegates the `coach`
    // module to the SAME two-layer source of truth (`user.disableCoach`
    // AND the operator assistant master flag) rather than owning a
    // second copy in `modulePreferencesJson`. Covered by the coach-
    // delegation cases in `src/lib/modules/__tests__/gate.test.ts`.
    "src/lib/modules/gate.ts",
    // The Modules hub Coach row renders a live switch bound to the SAME
    // `user.disableCoach` source of truth: `checked` is `!disableCoach` and a
    // flip writes the inverted flag via `PATCH /api/auth/me/disable-coach`.
    // Reads the flag off `useAuth().user` (no second copy). Covered by the
    // delegated-coach cases in
    // `src/components/settings/__tests__/modules-section.test.tsx`.
    "src/components/settings/modules-section.tsx",
  ];

  /**
   * Walk every TS / TSX file under `src/`, excluding test trees + the
   * Prisma client output, and collect the relative paths that
   * legitimately reference `useDisableCoach` or `user.disableCoach`.
   * Any literal occurrence on a non-comment line counts so a
   * contributor who paraphrases the read still trips this test.
   */
  function findDisableCoachSites(): string[] {
    const srcRoot = resolve(__dirname, "..", "..", "..");
    const repoRoot = resolve(srcRoot, "..");
    const hits: string[] = [];

    function isRealGateLine(line: string): boolean {
      // Trim once so leading whitespace doesn't fool the comment check.
      const trimmed = line.trim();
      if (trimmed.startsWith("//")) return false;
      if (trimmed.startsWith("*")) return false;
      // `useDisableCoach` covers both the hook import + the hook call.
      if (line.includes("useDisableCoach")) return true;
      // `user.disableCoach` / `user?.disableCoach` — the canonical
      // per-user gate read on the auth user object. Strict match on
      // `user` so we don't grab unrelated `disableCoach` strings (route
      // body keys, i18n message ids, …).
      if (/\buser\??\.disableCoach\b/.test(line)) return true;
      return false;
    }

    function walk(dir: string): void {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (entry === "node_modules" || entry === ".next") continue;
          if (entry === "__tests__") continue;
          // Skip the Prisma client output — the generator embeds the
          // entire `prisma/schema.prisma` source as a JSON-escaped
          // `inlineSchema` string and any schema doc-comment that
          // mentions `disableCoach` would otherwise leak through here.
          if (entry === "generated") continue;
          walk(full);
          continue;
        }
        if (!/\.(tsx|ts)$/.test(entry)) continue;
        if (/\.test\.(tsx|ts)$/.test(entry)) continue;
        const text = readFileSync(full, "utf8");
        if (text.split("\n").some(isRealGateLine)) {
          hits.push(relative(repoRoot, full).split(/[\\/]/).join("/"));
        }
      }
    }

    walk(srcRoot);
    return hits.sort();
  }

  it("grep-based discovery pins every `useDisableCoach` / `user.disableCoach` call site", () => {
    const discovered = findDisableCoachSites();
    const allowlist = new Set(KNOWN_DISABLE_COACH_GATE_SITES);
    const orphans = discovered.filter((path) => !allowlist.has(path));
    expect(
      orphans,
      [
        "Found `useDisableCoach` / `user.disableCoach` in file(s) not on",
        "the KNOWN_DISABLE_COACH_GATE_SITES allowlist",
        "(src/lib/feature-flags/__tests__/coach-user-disable.test.tsx).",
        "Add a fixture entry (or a sibling invariant) for the new gate,",
        "then add the path to the allowlist. Orphans:",
        ...orphans.map((p) => `  - ${p}`),
      ].join("\n"),
    ).toEqual([]);

    // Sanity check the other direction — an allowlist entry that no
    // longer references the gate is dead documentation and should be
    // pruned in the same PR that removes the read.
    const discoveredSet = new Set(discovered);
    const stale = KNOWN_DISABLE_COACH_GATE_SITES.filter(
      (path) => !discoveredSet.has(path),
    );
    expect(
      stale,
      [
        "KNOWN_DISABLE_COACH_GATE_SITES references file(s) that no longer",
        "use `useDisableCoach` / `user.disableCoach`. Remove the stale",
        "allowlist entry:",
        ...stale.map((p) => `  - ${p}`),
      ].join("\n"),
    ).toEqual([]);
  });
});
