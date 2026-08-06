import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { CROSS_TAB_STORAGE_STATE_PATH } from "./setup/test-helpers";

async function openSwitcher(page: Page) {
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test.describe.serial("cross-tab shared-record session switches", () => {
  test("holds a peer tab before both switch-in and switch-out change the shared session", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: CROSS_TAB_STORAGE_STATE_PATH,
    });
    const switchingPage = await context.newPage();
    const peerPage = await context.newPage();
    const pausedSwitches: ReturnType<typeof deferred>[] = [];
    const peerRecordReads: string[] = [];

    await switchingPage.route("**/api/account/switch", async (route) => {
      const pause = pausedSwitches.shift();
      if (pause) await pause.promise;
      await route.continue();
    });
    peerPage.on("request", (request) => {
      if (request.method() !== "GET") return;
      const path = new URL(request.url()).pathname;
      if (
        [
          "/api/dashboard/snapshot",
          "/api/insights/targets",
          "/api/medications",
          "/api/medications/compliance",
          "/api/labs",
          "/api/labs/ocr/capability",
          "/api/insights/coach/nudge-status",
        ].includes(path)
      ) {
        peerRecordReads.push(path);
      }
    });

    try {
      await Promise.all([switchingPage.goto("/"), peerPage.goto("/")]);
      await expect(
        peerPage.getByRole("button", { name: "User menu" }),
      ).toBeVisible();

      await openSwitcher(switchingPage);
      const entry = switchingPage.locator(
        '[data-slot="account-switcher-entry"][data-account-username="e2e-scope-labs"]',
      );
      await expect(entry).toBeVisible();
      const switchIn = deferred();
      pausedSwitches.push(switchIn);
      peerRecordReads.length = 0;
      const switchInClick = entry.click({ noWaitAfter: true });

      await expect(
        peerPage.locator('[data-slot="record-scope-hydration-gate"]'),
      ).toBeVisible();
      await expect(
        peerPage.getByRole("button", { name: "User menu" }),
      ).toHaveCount(0);
      await peerPage.waitForTimeout(200);
      expect(peerRecordReads).toEqual([]);

      switchIn.release();
      await switchInClick;
      await expect(
        switchingPage.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible();
      await expect(
        peerPage.locator('[data-slot="record-scope-hydration-gate"]'),
      ).toHaveCount(0);

      const switchOut = deferred();
      pausedSwitches.push(switchOut);
      peerRecordReads.length = 0;
      const switchOutClick = switchingPage
        .locator('[data-slot="shared-record-banner-exit"]')
        .click({ noWaitAfter: true });

      await expect(
        peerPage.locator('[data-slot="record-scope-hydration-gate"]'),
      ).toBeVisible();
      await expect(
        peerPage.locator('[data-slot="shared-record-banner"]'),
      ).toHaveCount(0);
      await peerPage.waitForTimeout(200);
      expect(peerRecordReads).toEqual([]);

      switchOut.release();
      await switchOutClick;
      await expect(
        switchingPage.getByRole("button", { name: "User menu" }),
      ).toBeVisible();
      await expect(
        peerPage.getByRole("button", { name: "User menu" }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
