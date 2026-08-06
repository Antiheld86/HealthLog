import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { SCOPE_A11Y_STORAGE_STATE_PATH } from "./setup/test-helpers";

async function scan(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

async function openProfileRecord(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
  const entry = page.locator(
    '[data-slot="account-switcher-entry"][data-account-username="e2e-scope-profile"]',
  );
  await expect(entry).toHaveCount(1);
  await entry.click();
  await expect(page).toHaveURL(/\/profile$/);
}

async function leaveRecord(page: Page) {
  await page.locator('[data-slot="shared-record-banner-exit"]').click();
  await expect(page.locator('[data-slot="shared-record-banner"]')).toHaveCount(
    0,
  );
}

test.describe("shared record accessibility states", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: SCOPE_A11Y_STORAGE_STATE_PATH });

  test("success and empty shared profile states have no WCAG violations", async ({
    page,
  }) => {
    await openProfileRecord(page);
    await expect(page.locator('[data-slot="profile-summary"]')).toBeVisible();
    await scan(page);
    await leaveRecord(page);
  });

  test("the capability hydration loading state has no WCAG violations", async ({
    page,
  }) => {
    await page.route("**/api/auth/me", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });
    await page.goto("/measurements");
    await expect(
      page.locator('[data-slot="record-scope-hydration-gate"]'),
    ).toBeVisible();
    await scan(page);
  });

  test("the shared profile read error state has no WCAG violations", async ({
    page,
  }) => {
    await page.route("**/api/profile/summary**", (route) =>
      route.fulfill({ status: 500, body: "{}" }),
    );
    await openProfileRecord(page);
    await expect(page.locator('[data-slot="query-error-card"]')).toBeVisible();
    await scan(page);
    await leaveRecord(page);
  });

  test("the shared-record refusal state has no WCAG violations", async ({
    page,
  }) => {
    await openProfileRecord(page);
    await page.goto("/settings/account");
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toBeVisible();
    await scan(page);
    await page.locator('[data-slot="shared-record-unavailable-leave"]').click();
  });
});
