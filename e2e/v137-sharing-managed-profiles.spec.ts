import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import {
  E2E_SCOPE_RECORDS,
  SCOPE_DELEGATE_STORAGE_STATE_PATH,
} from "./setup/test-helpers";

const DOMAIN_READS = {
  measurements: "/api/measurements",
  medications: "/api/medications",
  labs: "/api/labs",
  profile: "/api/profile/summary",
  illness: "/api/illness/episodes",
  mind: "/api/mood-entries",
  cycle: "/api/cycle/calendar",
  documents: "/api/documents/inbound",
} as const;

async function openSwitcher(page: Page) {
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
  await expect(
    page.locator('[data-slot="account-switcher-menu"]'),
  ).toBeVisible();
}

test.describe("scoped sharing browser journeys", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: SCOPE_DELEGATE_STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "scoped sharing seed has one session and runs once",
    );
  });

  for (const record of E2E_SCOPE_RECORDS) {
    test(`opens only the ${record.domain} record doorway`, async ({ page }) => {
      await page.goto("/");
      await openSwitcher(page);

      const entry = page
        .locator('[data-slot="account-switcher-entry"]')
        .filter({ hasText: record.username });
      await expect(entry).toHaveCount(1);

      const read = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === DOMAIN_READS[record.domain],
      );
      await entry.click();

      await expect(page).toHaveURL(new RegExp(`${record.href}$`));
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toContainText(record.username);
      await expect(
        page.locator(`a[href="${record.href}"]`).first(),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="shared-record-unavailable"]'),
      ).toHaveCount(0);
      await read;

      await page.locator('[data-slot="shared-record-banner-exit"]').click();
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toHaveCount(0);
    });
  }
});
