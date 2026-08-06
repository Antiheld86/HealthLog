import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import {
  E2E_LEVEL_RECORDS,
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

async function openRecord(page: Page, username: string) {
  await page.goto("/");
  await openSwitcher(page);

  const entry = page
    .locator('[data-slot="account-switcher-entry"]')
    .filter({ hasText: username });
  await expect(entry).toHaveCount(1);
  const accountId = await entry.getAttribute("data-account-id");
  if (accountId === null) {
    throw new Error(`Account switcher entry for ${username} has no account id`);
  }
  const accessLevel = await entry.getAttribute("data-access-level");
  const recordKind = await entry.getAttribute("data-record-kind");
  await entry.click();
  return { accountId, accessLevel, recordKind };
}

async function leaveRecord(page: Page) {
  await page.locator('[data-slot="shared-record-banner-exit"]').click();
  await expect(page.locator('[data-slot="shared-record-banner"]')).toHaveCount(
    0,
  );
}

test.describe.serial("scoped sharing browser journeys", () => {
  test.use({ storageState: SCOPE_DELEGATE_STORAGE_STATE_PATH });

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

      await leaveRecord(page);
    });
  }

  test("keeps an adult READ grant read-only and outside Settings", async ({
    page,
  }) => {
    const record = E2E_LEVEL_RECORDS.find(
      (candidate) => candidate.access === "READ",
    );
    if (!record) throw new Error("READ fixture is missing");

    const { accessLevel, recordKind } = await openRecord(page, record.username);
    expect(accessLevel).toBe("view");
    expect(recordKind).toBe("shared");

    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-access-level", "view");
    await expect(banner).toHaveAttribute("data-record-kind", "shared");
    await expect(banner).toContainText(record.username);

    await page.goto("/measurements");
    await expect(page.locator('[data-slot="measurement-add"]')).toHaveCount(0);

    await page.goto("/settings/account");
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toBeVisible();
    await leaveRecord(page);
  });

  test("lets an adult WRITE grant add only to the selected record", async ({
    page,
  }) => {
    const record = E2E_LEVEL_RECORDS.find(
      (candidate) => candidate.access === "WRITE",
    );
    if (!record) throw new Error("WRITE fixture is missing");

    const { accountId, accessLevel, recordKind } = await openRecord(
      page,
      record.username,
    );
    expect(accessLevel).toBe("view-and-add");
    expect(recordKind).toBe("shared");
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-account-id", accountId);
    await expect(banner).toHaveAttribute("data-access-level", "view-and-add");
    await expect(banner).toHaveAttribute("data-record-kind", "shared");

    await page.goto("/measurements");
    await expect(page.locator('[data-slot="measurement-add"]')).toBeVisible();
    const post = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/measurements",
    );
    await page.locator('[data-slot="measurement-add"]').click();
    await page.locator("#sys").fill("124");
    await page.locator("#dia").fill("78");
    await page.getByRole("button", { name: /^save$/i }).click();
    expect((await post).status()).toBeLessThan(300);

    const read = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/measurements",
    );
    await page.reload();
    const payload = await read;
    expect(JSON.stringify(await payload.json())).toContain("124");
    await expect(banner).toHaveAttribute("data-account-id", accountId);

    await page.goto("/settings/account");
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toBeVisible();
    await leaveRecord(page);
  });

  test("opens MANAGE-only generated reads without opening adult Settings", async ({
    page,
  }) => {
    const record = E2E_LEVEL_RECORDS.find(
      (candidate) =>
        candidate.access === "MANAGE" && candidate.recordKind === "shared",
    );
    if (!record) throw new Error("adult MANAGE fixture is missing");

    const { accessLevel, recordKind } = await openRecord(page, record.username);
    expect(accessLevel).toBe("manage");
    expect(recordKind).toBe("shared");
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-access-level", "manage");
    await expect(banner).toHaveAttribute("data-record-kind", "shared");

    const generatedRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/dashboard/summary",
    );
    await page.goto("/");
    expect((await generatedRead).status()).toBeLessThan(300);
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toHaveCount(0);

    await page.goto("/settings/account");
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toBeVisible();
    await leaveRecord(page);
  });

  test("keeps managed Settings on the active record and integrations status-only", async ({
    page,
  }) => {
    const record = E2E_LEVEL_RECORDS.find(
      (candidate) => candidate.recordKind === "managed",
    );
    if (!record) throw new Error("managed record fixture is missing");

    const { accountId, accessLevel, recordKind } = await openRecord(
      page,
      record.username,
    );
    expect(accessLevel).toBe("manage");
    expect(recordKind).toBe("managed");
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-account-id", accountId);
    await expect(banner).toHaveAttribute("data-access-level", "manage");
    await expect(banner).toHaveAttribute("data-record-kind", "managed");

    await page.goto("/settings/account");
    const profile = page.locator('[data-record-settings-family="profile"]');
    await expect(profile).toBeVisible();
    await expect(profile).toHaveAttribute("data-record-id", accountId);

    const integrationRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          "/api/record-settings/integrations",
    );
    await page.goto("/settings/integrations");
    const integrationResponse = await integrationRead;
    expect(integrationResponse.status()).toBeLessThan(300);
    const integrationPayload = (await integrationResponse.json()) as {
      data?: { recordId?: string };
    };
    expect(integrationPayload.data?.recordId).toBe(accountId);
    const integrations = page.locator(
      '[data-record-settings-family="integrations"]',
    );
    await expect(integrations).toBeVisible();
    await expect(integrations).toHaveAttribute("data-record-id", accountId);
    await expect(
      integrations.locator("button, input, select, textarea"),
    ).toHaveCount(0);

    await page.goBack();
    await expect(profile).toHaveAttribute("data-record-id", accountId);
    await page.goForward();
    await expect(integrations).toHaveAttribute("data-record-id", accountId);
    await expect(banner).toHaveAttribute("data-account-id", accountId);

    await leaveRecord(page);
    await page.goto("/measurements");
    await expect(banner).toHaveCount(0);
  });

  test("refuses direct ungranted routes before coach reads start", async ({
    page,
  }) => {
    await openRecord(page, "e2e-scope-measurements");
    const protectedCoachReads: string[] = [];
    const trackCoachRead = (request: { url(): string }) => {
      const path = new URL(request.url()).pathname;
      if (
        [
          "/api/insights/coach/nudge-status",
          "/api/coach/about-me/questions",
          "/api/auth/me/notification-prefs",
        ].includes(path)
      ) {
        protectedCoachReads.push(path);
      }
    };
    page.on("request", trackCoachRead);
    try {
      await page.goto("/coach");
      await expect(
        page.locator('[data-slot="shared-record-unavailable"]'),
      ).toBeVisible();
      expect(protectedCoachReads).toEqual([]);

      await page.goto("/settings/access");
      await expect(
        page.locator('[data-slot="shared-record-unavailable"]'),
      ).toBeVisible();
      expect(protectedCoachReads).toEqual([]);
    } finally {
      page.off("request", trackCoachRead);
    }
    await leaveRecord(page);
  });
});
