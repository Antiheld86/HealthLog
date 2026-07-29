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
        await settleBeforeMeasure(page, heading);
        await expect(sidebar).toBeVisible();

        const before = await page.evaluate(() => {
          const main = document.getElementById("main-content");
          const heading = main?.querySelector("h1");
          const aside = main?.querySelector("aside");
          const wrapper = main?.firstElementChild;
          if (!main || !heading || !aside || !wrapper) return null;
          return {
            headingTop: heading.getBoundingClientRect().top,
            asideTop: aside.getBoundingClientRect().top,
            wrapperLeft: wrapper.getBoundingClientRect().left,
            mainWidth: main.clientWidth,
            documentScrollable:
              document.documentElement.scrollHeight >
              document.documentElement.clientHeight + 1,
          };
        });

        expect(before).not.toBeNull();
        if (!before) return;
        expect(
          Math.abs(before.asideTop - before.headingTop),
        ).toBeLessThanOrEqual(2);
        expect(before.documentScrollable).toBe(false);

        await page.locator("#main-content").evaluate((main) => {
          main.scrollTop = Math.min(320, main.scrollHeight - main.clientHeight);
        });
        await page.waitForFunction(() => {
          const main = document.getElementById("main-content");
          return (
            !main ||
            main.scrollTop > 0 ||
            main.scrollHeight <= main.clientHeight
          );
        });

        const after = await page.evaluate(() => {
          const main = document.getElementById("main-content");
          const aside = main?.querySelector("aside");
          const wrapper = main?.firstElementChild;
          if (!main || !aside || !wrapper) return null;
          return {
            asideTop: aside.getBoundingClientRect().top,
            wrapperLeft: wrapper.getBoundingClientRect().left,
            mainWidth: main.clientWidth,
          };
        });

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
