/**
 * v1.4.34 IW-B — auth-shell hoist contract.
 *
 * The Coach launch provider used to live on `app/insights/layout.tsx`,
 * which meant the drawer was only reachable from `/insights/**`. The
 * hoist moves the provider + the drawer mount to `<AuthShell>` so every
 * authenticated route (dashboard included) shares the same context and
 * can call `askCoach()` from any descendant.
 *
 * Project convention keeps this contract pinned at the source level
 * because `<AuthShell>` is hard to render under SSR (it reads
 * `useAuth()` + `usePathname()` + the router) and we don't want a fully
 * mocked `@testing-library/react` setup for a one-line invariant.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const AUTH_SHELL_PATH = resolve(__dirname, "..", "auth-shell.tsx");
const INSIGHTS_LAYOUT_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "app",
  "insights",
  "layout.tsx",
);

describe("v1.4.34 IW-B — CoachLaunchProvider hoist", () => {
  it("imports the CoachLaunchProvider in the auth-shell", () => {
    const source = readFileSync(AUTH_SHELL_PATH, "utf8");
    expect(source).toContain('from "@/lib/insights/coach-launch-context"');
    expect(source).toContain("CoachLaunchProvider");
  });

  it("mounts the LayoutCoachMount inside the auth-shell so the drawer is reachable globally", () => {
    const source = readFileSync(AUTH_SHELL_PATH, "utf8");
    expect(source).toContain("<LayoutCoachMount />");
  });

  it("mounts the LayoutCoachFab inside the auth-shell so the launcher exists on every authenticated route (v1.16.8)", () => {
    const source = readFileSync(AUTH_SHELL_PATH, "utf8");
    expect(source).toContain("<LayoutCoachFab />");
  });

  it("gates the LayoutCoachFab on `!demoMode` so demo visitors can't hit the proxy-blocked send (v1.16.13)", () => {
    const source = readFileSync(AUTH_SHELL_PATH, "utf8");
    // `/api/insights/chat` is not in the proxy's DEMO_MUTATION_ALLOWLIST,
    // so a tappable FAB in demo mode produces a raw 403 on send. The mount
    // must be conditioned on the demo flag.
    //
    // v1.36.x — `!inSharedRecord` joins the same condition. What that gate is
    // FOR, and the paint it produces at both grant levels, is asserted against
    // rendered markup in `auth-shell-shared-record-doors.test.tsx`; this leg
    // only holds the demo half that predates it.
    expect(source).toContain(
      "{!demoMode && !inSharedRecord && <LayoutCoachFab />}",
    );
  });

  it("no longer mounts any Coach surface in the routed insights layout", () => {
    const source = readFileSync(INSIGHTS_LAYOUT_PATH, "utf8");
    // The provider import drops; the drawer mount lives on the shell.
    expect(source).not.toContain('from "@/lib/insights/coach-launch-context"');
    expect(source).not.toContain("import { LayoutCoachMount }");
    // v1.16.8 — the FAB moved to the shell too; the routed layout must
    // not double-mount it. (The docblock may still narrate the move, so
    // pin the import + JSX, not the bare name.)
    expect(source).not.toContain(
      'from "@/components/insights/layout-coach-fab"',
    );
    expect(source).not.toContain("<LayoutCoachFab");
  });
});
