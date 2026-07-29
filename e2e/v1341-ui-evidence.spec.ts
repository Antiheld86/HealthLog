import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  LONG_HEADLINE_BRIEFING,
  mockDashboardSnapshot,
} from "./utils/mock-dashboard-snapshot";
import { mockPopulatedInsights } from "./utils/mock-populated-insights";
import { settleBeforeMeasure } from "./utils/settle";

const EVIDENCE_DIR = join(process.cwd(), "test-results", "v1341");

async function settleAndCapture(
  page: Page,
  testInfo: TestInfo,
  filename: string,
): Promise<void> {
  await settleBeforeMeasure(page, page.locator("#main-content"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
  });
  await page.evaluate(() => document.fonts?.ready);
  const path = join(EVIDENCE_DIR, filename);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(filename, { path, contentType: "image/png" });
}

test.describe("v1.34.1 deterministic UI evidence", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "one canonical capture per named evidence file",
    );
  });

  test("captures the five release-review surfaces", async ({
    page,
  }, testInfo) => {
    await mkdir(EVIDENCE_DIR, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await mockDashboardSnapshot(page, {
      briefing: LONG_HEADLINE_BRIEFING,
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#main-content")).toBeVisible();
    await settleAndCapture(page, testInfo, "dashboard-desktop.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await mockPopulatedInsights(page);
    await page.goto("/insights", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-slot="insights-tab-strip"]'),
    ).toBeVisible();
    await settleAndCapture(page, testInfo, "insights-mobile.png");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings/anamnesis", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settleAndCapture(page, testInfo, "anamnesis-desktop.png");

    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto("/settings/account", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settleAndCapture(page, testInfo, "settings-short-desktop.png");

    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/admin/system-status", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settleAndCapture(page, testInfo, "admin-tablet.png");
  });
});
