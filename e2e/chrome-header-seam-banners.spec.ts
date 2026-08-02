import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * The seam again, this time with chrome above it.
 *
 * `chrome-header-seam.spec.ts` measures the two header borders on a shell with
 * nothing above them. That is the state almost every session is in, and it is
 * also the only state in which the seam cannot break: with no banner painted,
 * the sidebar logo band and the top bar both start at y=0 whatever the layout
 * does with them.
 *
 * The banners are the case that breaks it. Each one is a full-width strip that
 * paints above the top bar, and while they lived INSIDE the content column they
 * pushed the top bar down while the sidebar band stayed where it was — one line
 * across the top of the app became two lines a banner-height apart, and three
 * can stack at once. Measured before the fix, on the French locale strip: one
 * banner offset the two borders by 66.5px at 768px and 61.0px at 1280px, and
 * all three together by 184.5px and 143.0px. So this spec forces them on and
 * measures the same two borders.
 *
 * ## How each banner is forced
 *
 * Honestly, through the condition the component actually reads — no injected
 * DOM, no test-only prop:
 *
 *   - **Maintainership** paints on a locale HealthLog does not hand-maintain.
 *     The context cookie is switched from `en` to `fr`, which is what a
 *     French-speaking user's browser carries. The swap happens with no page
 *     alive (`about:blank`): `I18nProvider` rewrites `healthlog-locale` from
 *     its own active locale on mount, so a cookie written under a live English
 *     page is reverted within the second.
 *   - **Shared record** paints from `accountAccess.active` on `/api/auth/me`.
 *     The real payload is captured first and served back with that block
 *     filled, rather than performing a real switch: the switch is stamped on
 *     the SESSION ROW, so switching the shared cookie jar would switch it for
 *     every other spec holding the same cookie (see
 *     `DELEGATE_STORAGE_STATE_PATH` in `global-setup.ts` for what that costs).
 *     A captured-and-patched payload keeps this file's reach inside this file,
 *     and it keeps working after the offline stage because it never touches the
 *     network again.
 *   - **Offline** paints while `navigator.onLine` is false, which
 *     `context.setOffline(true)` produces for real, event and all. It is armed
 *     last because it is the only stage a navigation cannot follow.
 *
 * The demo banner is the one that cannot be forced from a spec: `DEMO_MODE` is
 * a server env var read by the root layout, and the suite shares one server
 * whose mutations would all be blocked by turning it on. It is the same strip
 * as the other three (`border-b px-3 py-2 text-xs`) in the same place in the
 * stack, so the three forced here exercise its geometry; nothing in the stack
 * is specific to which banner is in it.
 *
 * ## What is asserted
 *
 * Two properties, and the second is why the banners were hoisted above the
 * shell row rather than nudged inside it:
 *
 *   1. The seam holds — the two header borders keep sharing one line at every
 *      stack depth, so chrome above the header cannot displace one band and
 *      not the other.
 *   2. The shell stays inside the viewport — the banners are part of the
 *      `h-dvh` budget, not added on top of it, so no depth of stack introduces
 *      a page-level scrollbar. `<main>` remains the only vertical scroller.
 *
 * Property 2 runs on mobile too, where there is no sidebar and therefore no
 * seam, because the scroll model is the half of the layout that the hoist could
 * have broken at that breakpoint.
 */

const LOCALE_COOKIE = "healthlog-locale";

/**
 * Every banner that can paint above the top bar, so a stage can assert how many
 * are up rather than only that the one it armed is.
 */
const BANNER_SLOTS = [
  "offline-banner",
  "shared-record-banner",
  "demo-banner",
  "maintainership-banner",
] as const;

type Band = { bottom: number; height: number; borderBottomWidth: number };

type ShellGeometry = {
  topBar: Band | null;
  sidebar: Band | null;
  bannerCount: number;
  bannerHeight: number;
  /** `scrollHeight - clientHeight` of the document's scrolling element. */
  documentOverflow: number;
  viewportHeight: number;
};

async function readShell(page: Page): Promise<ShellGeometry> {
  return page.evaluate(
    (slots: string[]) => {
      const band = (slot: string) => {
        const el = document.querySelector(`[data-slot="${slot}"]`);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          height: rect.height,
          borderBottomWidth: parseFloat(
            getComputedStyle(el).borderBottomWidth || "0",
          ),
        };
      };
      const banners = slots
        .map((slot) => document.querySelector(`[data-slot="${slot}"]`))
        .filter((el): el is Element => el != null);
      const scroller = document.scrollingElement ?? document.documentElement;
      return {
        topBar: band("top-bar"),
        sidebar: band("sidebar-header"),
        bannerCount: banners.length,
        bannerHeight: banners.reduce(
          (sum, el) => sum + el.getBoundingClientRect().height,
          0,
        ),
        documentOverflow: scroller.scrollHeight - scroller.clientHeight,
        viewportHeight: window.innerHeight,
      };
    },
    BANNER_SLOTS as unknown as string[],
  );
}

/**
 * The live `/api/auth/me` body, read through the page so it carries the page's
 * own cookies. Captured before anything else is armed, so the mock that later
 * replaces it differs from the real payload in exactly one block.
 */
async function captureAccountPayload(page: Page): Promise<string> {
  const raw = await page.evaluate(async () => {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    return res.ok ? await res.text() : null;
  });
  expect(
    raw,
    "could not capture /api/auth/me for the sharing mock",
  ).not.toBeNull();
  return raw!;
}

/**
 * Serve the captured payload back with the sharing block filled in, so the
 * shell believes this session is inside somebody else's record. Everything else
 * the shell reads (modules, role, onboarding flags) stays what the server said.
 */
async function armSharedRecord(page: Page, captured: string): Promise<void> {
  const payload = JSON.parse(captured) as { data: Record<string, unknown> };
  const entry = {
    accountId: "seam-fixture-account",
    username: "seam-owner",
    displayName: null,
    access: "read" as const,
    canWrite: false,
  };
  payload.data.accountAccess = {
    accounts: [entry],
    active: entry,
    canSwitch: true,
  };
  const body = JSON.stringify(payload);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body }),
  );
}

/**
 * Swap the context's pinned locale for one HealthLog ships as an AI-initial
 * translation, so the maintainership strip has a reason to paint.
 *
 * The page is parked on `about:blank` for the swap. `I18nProvider` mirrors its
 * ACTIVE locale into this cookie from an effect, so a cookie written while an
 * English page is mounted is reverted before the next navigation can read it —
 * measured, not assumed: the value flipped back inside one second. With no page
 * running, the next navigation sends `fr` and the provider then mirrors `fr`.
 */
async function armUnmaintainedLocale(page: Page): Promise<void> {
  const host = new URL(page.url()).hostname;
  await page.goto("about:blank");
  await page.context().addCookies([
    {
      name: LOCALE_COOKIE,
      value: "fr",
      domain: host,
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

/**
 * Take the context offline and make sure the banner hears about it.
 *
 * `setOffline` produces the real condition — `navigator.onLine` flips to false,
 * which is asserted here rather than assumed. Delivery of the `offline` EVENT
 * to an already-loaded page is the part that is not reliable: this spec caught
 * it missing once under a fully parallel run while passing three for three on
 * its own. `<OfflineBanner>` only reads `navigator.onLine` at mount and
 * otherwise waits on the event, so the event is re-dispatched here. That is the
 * notification, not the condition, and the condition is verified first.
 */
async function armOffline(page: Page): Promise<void> {
  // Let whatever is in flight land first. The Playwright context runs with
  // `serviceWorkers: "block"`, so nothing has pre-cached the app shell and a
  // lazily-imported chunk cut off mid-download throws the whole tree to the
  // global error boundary — "Failed to load chunk … from module …", no top bar,
  // no banner. That is a property of the harness rather than of the shell (a
  // real install serves those chunks from the worker cache), so it is waited
  // out rather than asserted on. Best-effort: a polling surface can keep the
  // network from ever going fully idle.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
}

test.describe("app-chrome header seam under banners", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("the header seam survives every depth of the banner stack", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name === "chromium-mobile",
      "the sidebar is desktop-only (md+), so below md there is no seam to measure",
    );
    // Four stages measured at two widths, with a full page load per stage and
    // a network settle either side of the offline one. Comfortably inside the
    // suite default when it runs alone; the default 30s is not enough headroom
    // for it on a loaded machine.
    test.setTimeout(60_000);

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const topBar = page.locator('[data-slot="top-bar"]');
    const sidebarHeader = page.locator('[data-slot="sidebar-header"]');
    await expect(topBar).toBeVisible();
    await expect(sidebarHeader).toBeVisible();

    const captured = await captureAccountPayload(page);

    // Each stage adds one banner and leaves the previous ones up, so the last
    // stage measures the whole stack rather than one banner at a time.
    //
    // `beforeResize` / `afterResize` exist for the offline stage alone: a
    // viewport change can pull a chunk the page has not loaded yet, and a chunk
    // fetch that fails with no network takes the whole shell down to the global
    // error boundary. Observed once under `--repeat-each=3`, as a missing top
    // bar and a "Failed to load chunk" screen. So the network comes back for
    // the resize and the stage re-arms after it — the measurement is still
    // taken offline, with the banner up.
    type Stage = {
      label: string;
      arm: () => Promise<void>;
      beforeResize?: () => Promise<void>;
      afterResize?: () => Promise<void>;
    };
    const stages: Stage[] = [
      { label: "no banner", arm: async () => {} },
      {
        label: "1 banner (maintainership)",
        arm: async () => {
          await armUnmaintainedLocale(page);
          await page.goto("/", { waitUntil: "domcontentloaded" });
          await expect(
            page.locator('[data-slot="maintainership-banner"]'),
          ).toBeVisible();
        },
      },
      {
        label: "2 banners (+ shared record)",
        arm: async () => {
          await armSharedRecord(page, captured);
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect(
            page.locator('[data-slot="shared-record-banner"]'),
          ).toBeVisible();
        },
      },
      {
        label: "3 banners (+ offline)",
        arm: async () => {},
        beforeResize: async () => {
          await page.context().setOffline(false);
          await expect
            .poll(() => page.evaluate(() => navigator.onLine))
            .toBe(true);
        },
        afterResize: async () => {
          await armOffline(page);
          await expect(
            page.locator('[data-slot="offline-banner"]'),
          ).toBeVisible();
        },
      },
    ];

    // Stage outside, width inside: each banner is armed once and the resulting
    // stack measured at both widths. 768px is the `md` breakpoint where the
    // sidebar first appears — the narrowest shell that has a seam at all, and
    // the width where a banner is most likely to wrap onto a second line.
    for (const [index, stage] of stages.entries()) {
      await stage.arm();

      for (const width of [768, 1280] as const) {
        await stage.beforeResize?.();
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() => page.evaluate(() => window.innerWidth))
          .toBe(width);
        await stage.afterResize?.();
        await expect(topBar).toBeVisible();
        await expect(sidebarHeader).toBeVisible();

        const shell = await readShell(page);
        const at = `at ${width}px, ${stage.label}`;

        expect(shell.topBar, `top bar missing ${at}`).not.toBeNull();
        expect(shell.sidebar, `sidebar band missing ${at}`).not.toBeNull();
        const top = shell.topBar!;
        const side = shell.sidebar!;

        // Two borders that do not exist also "line up".
        expect(
          top.borderBottomWidth,
          `top bar has no bottom border ${at}`,
        ).toBeGreaterThan(0);
        expect(
          side.borderBottomWidth,
          `sidebar band has no bottom border ${at}`,
        ).toBeGreaterThan(0);

        // The stage armed what it said it armed. Without this a change that
        // stopped every banner from painting would make the seam assertion
        // below trivially true.
        expect(
          shell.bannerCount,
          `${at}: expected ${index} banner(s) painted, found ${shell.bannerCount}`,
        ).toBe(index);
        if (index > 0) {
          expect(
            shell.bannerHeight,
            `${at}: the banners paint no height, so this stage proves nothing`,
          ).toBeGreaterThan(0);
        }

        // The seam. A banner that displaces one band and not the other shows
        // up here as a step the size of the stack.
        expect(
          Math.abs(side.bottom - top.bottom),
          `${at}: header seam steps by ${(side.bottom - top.bottom).toFixed(
            2,
          )}px — the banner stack (${shell.bannerHeight.toFixed(
            2,
          )}px) is displacing one band and not the other`,
        ).toBeLessThan(1);

        // The banners come out of the viewport budget, not on top of it.
        expect(
          shell.documentOverflow,
          `${at}: the document scrolls by ${shell.documentOverflow.toFixed(
            2,
          )}px — the banner stack pushed the shell past the viewport`,
        ).toBeLessThan(1);
      }
    }
  });

  test("the banner stack never pushes the shell past the viewport", async ({
    page,
  }) => {
    // Mobile as well as desktop. Below `md` the shell stacks in a column and
    // there is no sidebar, so there is no seam to measure — but the scroll
    // model is what hoisting the banners could have broken there, and that
    // half is measurable at both breakpoints.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="top-bar"]')).toBeVisible();

    const captured = await captureAccountPayload(page);
    await armSharedRecord(page, captured);
    await armUnmaintainedLocale(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-slot="maintainership-banner"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toBeVisible();
    await armOffline(page);
    await expect(page.locator('[data-slot="offline-banner"]')).toBeVisible();

    const shell = await readShell(page);
    expect(shell.bannerCount, "the stack did not arm").toBe(3);
    expect(shell.bannerHeight).toBeGreaterThan(0);
    expect(
      shell.documentOverflow,
      `the document scrolls by ${shell.documentOverflow.toFixed(
        2,
      )}px under a ${shell.bannerHeight.toFixed(2)}px banner stack`,
    ).toBeLessThan(1);

    // The top bar is still fully painted below the stack rather than pushed
    // off the bottom of the viewport.
    const top = shell.topBar!;
    expect(top.height).toBeGreaterThan(32);
    expect(
      top.bottom,
      "the banner stack pushed the top bar out of the viewport",
    ).toBeLessThanOrEqual(shell.viewportHeight);
  });
});
