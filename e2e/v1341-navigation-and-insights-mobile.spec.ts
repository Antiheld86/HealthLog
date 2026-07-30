import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { mockPopulatedInsights } from "./utils/mock-populated-insights";
import { settleBeforeMeasure } from "./utils/settle";

test.describe("v1.34.1 navigation geometry", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "short desktop", width: 1280, height: 600 },
    { name: "tablet", width: 900, height: 700 },
  ]) {
    for (const route of ["/settings/account", "/admin/system-status"]) {
      test(`${route} aligns and pins its sidebar at ${viewport.name}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await page.goto(route, { waitUntil: "domcontentloaded" });

        const heading = page.getByRole("heading", { level: 1 });
        const sidebar = page.locator("aside").first();
        // The wrapper carries a stable `data-slot` (auth-shell.tsx) so both
        // reads below measure the same DOM node instead of resolving
        // `firstElementChild` twice — a lazily-mounted sibling (portal,
        // toast, hydrating region) landing ahead of it between the two
        // reads used to substitute a different element into the second
        // measurement, producing an unrelated number rather than a
        // drifted one. Resolving the handle once removes the second
        // resolution step entirely.
        const wrapper = page.locator('[data-slot="main-content-wrapper"]');
        await settleBeforeMeasure(page, heading);
        await expect(sidebar).toBeVisible();
        await expect(wrapper).toBeVisible();
        const wrapperHandle = await wrapper.elementHandle();
        if (!wrapperHandle) {
          throw new Error("main content wrapper not found");
        }

        const before = await page.evaluate((wrapperEl) => {
          const main = document.getElementById("main-content");
          const heading = main?.querySelector("h1");
          const aside = main?.querySelector("aside");
          if (!main || !heading || !aside || !wrapperEl) return null;
          return {
            headingTop: heading.getBoundingClientRect().top,
            asideTop: aside.getBoundingClientRect().top,
            wrapperLeft: wrapperEl.getBoundingClientRect().left,
            mainWidth: main.clientWidth,
            documentScrollable:
              document.documentElement.scrollHeight >
              document.documentElement.clientHeight + 1,
          };
        }, wrapperHandle);

        expect(before).not.toBeNull();
        if (!before) return;
        expect(
          Math.abs(before.asideTop - before.headingTop),
        ).toBeLessThanOrEqual(2);
        expect(before.documentScrollable).toBe(false);

        await page.locator("#main-content").evaluate((main) => {
          main.scrollTop = Math.min(320, main.scrollHeight - main.clientHeight);
        });
        // Gate on the wrapper being present and laid out (not just on
        // scroll state) — the measurement below reads it, so the wait
        // must cover everything that measurement depends on.
        await page.waitForFunction((wrapperEl) => {
          const main = document.getElementById("main-content");
          if (!main) return true;
          const wrapperReady =
            !!wrapperEl &&
            wrapperEl.isConnected &&
            wrapperEl.getBoundingClientRect().width > 0;
          return (
            wrapperReady &&
            (main.scrollTop > 0 || main.scrollHeight <= main.clientHeight)
          );
        }, wrapperHandle);

        const after = await page.evaluate((wrapperEl) => {
          const main = document.getElementById("main-content");
          const aside = main?.querySelector("aside");
          if (!main || !aside || !wrapperEl) return null;
          return {
            asideTop: aside.getBoundingClientRect().top,
            wrapperLeft: wrapperEl.getBoundingClientRect().left,
            mainWidth: main.clientWidth,
          };
        }, wrapperHandle);
        await wrapperHandle.dispose();

        expect(after).not.toBeNull();
        if (!after) return;
        expect(Math.abs(after.asideTop - before.asideTop)).toBeLessThanOrEqual(
          2,
        );
        expect(after.wrapperLeft).toBe(before.wrapperLeft);
        expect(after.mainWidth).toBe(before.mainWidth);
      });
    }
  }
});

test.describe("v1.34.1 mobile Insights pill row", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("has no unexplained gap above the row and preserves focus, safe bounds, and 44px targets", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockPopulatedInsights(page);
    await page.goto("/insights", { waitUntil: "domcontentloaded" });

    const firstPill = page
      .locator(
        '[data-slot="insights-tab-strip-pill"], [data-slot="insights-tab-strip-group"]',
      )
      .first();
    await settleBeforeMeasure(page, firstPill);

    const geometry = await page.evaluate(() => {
      const main = document.getElementById("main-content");
      const strip = document.querySelector<HTMLElement>(
        '[data-slot="insights-tab-strip"]',
      );
      const pill = document.querySelector<HTMLElement>(
        '[data-slot="insights-tab-strip-pill"], [data-slot="insights-tab-strip-group"]',
      );
      if (!main || !strip || !pill) return null;
      const mainRect = main.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      const pillRect = pill.getBoundingClientRect();
      return {
        gapAbove: stripRect.top - mainRect.top,
        stripLeft: stripRect.left,
        stripRight: stripRect.right,
        mainLeft: mainRect.left,
        mainRight: mainRect.right,
        pillHeight: pillRect.height,
        mainOverflows: main.scrollWidth > main.clientWidth + 1,
        documentOverflows:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      };
    });

    expect(geometry).not.toBeNull();
    if (!geometry) return;
    expect(geometry.gapAbove).toBeLessThanOrEqual(4);
    expect(geometry.stripLeft).toBeGreaterThanOrEqual(geometry.mainLeft);
    expect(geometry.stripRight).toBeLessThanOrEqual(geometry.mainRight);
    expect(geometry.pillHeight).toBeGreaterThanOrEqual(44);
    expect(geometry.mainOverflows).toBe(false);
    expect(geometry.documentOverflows).toBe(false);

    await firstPill.focus();
    await expect(firstPill).toBeFocused();
    expect(
      await firstPill.evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          element.matches(":focus-visible") &&
          (style.outlineStyle !== "none" || style.boxShadow !== "none")
        );
      }),
    ).toBe(true);
  });
});
