import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * The bottom border of the top bar and the bottom border of the sidebar logo
 * band form one horizontal line across the top of the app. The two elements
 * sit in different columns of the shell flex row, so nothing in the layout
 * makes them agree; both read `SHELL_HEADER_BAND`
 * (`src/components/layout/shell-metrics.ts`) for the height AND the border,
 * which is what keeps the line continuous.
 *
 * The structural half of that contract is asserted in
 * `src/components/layout/__tests__/chrome-header-seam.test.tsx`. This spec
 * asserts the painted result: same border bottom edge, same border width, at
 * four widths spanning the sidebar's visible range, in both the expanded
 * sidebar and the collapsed icon rail.
 *
 * The waits below settle on the two bands being VISIBLE and on the viewport
 * having actually resized. Nothing here waits on a height or an offset, so a
 * regression cannot hide behind the setup.
 */

// 768 px is the `md` breakpoint where the sidebar first appears; 1024 px is
// `lg`, where an unset collapse preference flips the rail to icons. Both
// boundaries and one width either side of them.
const WIDTHS = [768, 900, 1024, 1280] as const;

const SIDEBAR_COLLAPSED_KEY = "healthlog-sidebar-collapsed";

type BandGeometry = {
  bottom: number;
  height: number;
  borderBottomWidth: number;
};

test.describe("app-chrome header seam", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name === "chromium-mobile",
      "the global sidebar is desktop-only (md+), so below md there is no seam",
    );
  });

  for (const collapsed of [false, true] as const) {
    test(`top bar and sidebar borders share one line (${
      collapsed ? "collapsed rail" : "expanded sidebar"
    })`, async ({ page }) => {
      // Pin the rail state instead of letting the viewport default decide, so
      // each run covers both shapes at every width.
      await page.addInitScript(
        ([key, value]) => {
          window.localStorage.setItem(key, value);
        },
        [SIDEBAR_COLLAPSED_KEY, String(collapsed)] as const,
      );

      await page.goto("/", { waitUntil: "domcontentloaded" });

      const topBar = page.locator('[data-slot="top-bar"]');
      const sidebarHeader = page.locator('[data-slot="sidebar-header"]');

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });

        // Settle on paint, not on geometry: both bands present and visible,
        // the logo link inside the sidebar band rendered, and the viewport
        // actually at the requested width.
        await expect(topBar).toBeVisible();
        await expect(sidebarHeader).toBeVisible();
        await expect(sidebarHeader.locator("a[href='/']")).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => window.innerWidth))
          .toBe(width);

        const seam = await page.evaluate(() => {
          const read = (slot: string) => {
            const el = document.querySelector(`[data-slot="${slot}"]`);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              bottom: rect.bottom,
              height: rect.height,
              borderBottomWidth: parseFloat(style.borderBottomWidth),
            };
          };
          return {
            topBar: read("top-bar"),
            sidebar: read("sidebar-header"),
          } as { topBar: BandGeometry | null; sidebar: BandGeometry | null };
        });

        const at = `at ${width}px (${collapsed ? "collapsed" : "expanded"})`;
        expect(seam.topBar, `top bar missing ${at}`).not.toBeNull();
        expect(seam.sidebar, `sidebar band missing ${at}`).not.toBeNull();
        const top = seam.topBar!;
        const side = seam.sidebar!;

        // Two borders that do not exist also "line up". Prove each band
        // actually paints a line, and paints it at the same weight, before
        // comparing where the lines sit.
        expect(
          top.borderBottomWidth,
          `top bar has no bottom border ${at}`,
        ).toBeGreaterThan(0);
        expect(
          side.borderBottomWidth,
          `sidebar band has no bottom border ${at}`,
        ).toBeGreaterThan(0);
        expect(
          side.borderBottomWidth,
          `the two borders are drawn at different weights ${at}`,
        ).toBeCloseTo(top.borderBottomWidth, 1);

        // The bands are collapsed neither to zero nor to a sliver.
        expect(top.height, `top bar has no height ${at}`).toBeGreaterThan(32);
        expect(side.height, `sidebar band has no height ${at}`).toBeGreaterThan(
          32,
        );

        // The seam itself: the bottom border sits on the band's border-box
        // bottom edge, so equal bottoms means one continuous line.
        expect(
          Math.abs(side.bottom - top.bottom),
          `header seam steps by ${(side.bottom - top.bottom).toFixed(
            2,
          )}px ${at}`,
        ).toBeLessThan(1);
      }
    });
  }
});
