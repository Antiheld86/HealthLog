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

  const entry = page.locator(
    `[data-slot="account-switcher-entry"][data-account-username="${username}"]`,
  );
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

function withDivergentActiveAccountAccess(body: unknown): unknown {
  if (body === null || typeof body !== "object") {
    throw new Error("Expected an object from /api/auth/me");
  }

  const envelope = body as { data?: unknown };
  const payload = "data" in envelope ? envelope.data : envelope;
  if (payload === null || typeof payload !== "object") {
    throw new Error("Expected an auth payload from /api/auth/me");
  }

  const auth = payload as {
    accountAccess?: {
      active?: {
        access?: unknown;
        level?: unknown;
        canWrite?: unknown;
      } | null;
    };
  };
  if (!auth.accountAccess?.active) {
    throw new Error("Expected a switched account-access payload");
  }

  const corrupted = {
    ...auth,
    accountAccess: {
      ...auth.accountAccess,
      active: {
        ...auth.accountAccess.active,
        access: "write",
        level: "write",
        canWrite: true,
      },
    },
  };
  return "data" in envelope ? { ...envelope, data: corrupted } : corrupted;
}

test.describe.serial("scoped sharing browser journeys", () => {
  test.use({ storageState: SCOPE_DELEGATE_STORAGE_STATE_PATH });

  for (const record of E2E_SCOPE_RECORDS) {
    test(`opens only the ${record.domain} record doorway`, async ({ page }) => {
      await page.goto("/");
      await openSwitcher(page);

      const entry = page.locator(
        `[data-slot="account-switcher-entry"][data-account-username="${record.username}"]`,
      );
      await expect(entry).toHaveCount(1);

      const unexpectedOcrCapability =
        record.domain === "labs"
          ? page.waitForRequest(
              (request) =>
                request.method() === "GET" &&
                new URL(request.url()).pathname === "/api/labs/ocr/capability",
              { timeout: 500 },
            )
          : null;
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
      if (unexpectedOcrCapability) {
        await expect(unexpectedOcrCapability).rejects.toThrow(/Timeout/);
      }

      await leaveRecord(page);
    });
  }

  test("refuses a malformed switched payload before target or owner reads mount", async ({
    page,
  }) => {
    await page.goto("/");
    await openSwitcher(page);

    const entry = page.locator(
      '[data-slot="account-switcher-entry"][data-account-username="e2e-scope-labs"]',
    );
    await expect(entry).toHaveCount(1);

    // The switch normally writes this mirror before its full reload. Remove it
    // in the new document so the global preloaders cannot guess an own-record
    // scope while `/api/auth/me` is still deciding whether the target is safe.
    await page.addInitScript(() => {
      localStorage.removeItem("healthlog-record-scope");
    });

    let corruptAuthPayload = true;
    await page.route("**/api/auth/me", async (route) => {
      const response = await route.fetch();
      if (!corruptAuthPayload) {
        await route.fulfill({ response });
        return;
      }
      await route.fulfill({
        response,
        json: withDivergentActiveAccountAccess(await response.json()),
      });
    });

    const ownerOnlyReads: string[] = [];
    const trackOwnerOnlyRead = (request: {
      method(): string;
      url(): string;
    }) => {
      if (request.method() !== "GET") return;
      const path = new URL(request.url()).pathname;
      if (
        [
          "/api/labs/ocr/capability",
          "/api/insights/coach/nudge-status",
          "/api/coach/about-me/questions",
          "/api/auth/me/notification-prefs",
        ].includes(path)
      ) {
        ownerOnlyReads.push(path);
      }
    };
    page.on("request", trackOwnerOnlyRead);
    const targetPreloads: string[] = [];
    const trackTargetPreload = (request: {
      method(): string;
      url(): string;
    }) => {
      if (request.method() !== "GET") return;
      const path = new URL(request.url()).pathname;
      if (
        [
          "/api/dashboard/snapshot",
          "/api/medications",
          "/api/medications/compliance",
        ].includes(path)
      ) {
        targetPreloads.push(path);
      }
    };
    page.on("request", trackTargetPreload);
    try {
      await entry.click();

      await expect(page).toHaveURL(/\/labs$/);
      await expect(
        page.locator('[data-slot="invalid-record-access-refusal"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="shared-record-unavailable-leave"]'),
      ).toBeVisible();
      await expect(page.locator('[data-tour-id="labs-hero"]')).toHaveCount(0);
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toHaveCount(0);

      // Both global preloader routes must remain inert while the malformed
      // response is refused, even though the scope mirror was intentionally
      // cleared before each reload.
      await page.goto("/");
      await expect(
        page.locator('[data-slot="invalid-record-access-refusal"]'),
      ).toBeVisible();
      await page.goto("/medications");
      await expect(
        page.locator('[data-slot="invalid-record-access-refusal"]'),
      ).toBeVisible();
      expect(ownerOnlyReads).toEqual([]);
      expect(targetPreloads).toEqual([]);

      // Leave the refused record, then demand fresh own-record reads. This
      // catches a response that was parked under the owner hash while the
      // refusal was on screen and would otherwise paint without a new request.
      corruptAuthPayload = false;
      const freshDashboard = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/api/dashboard/snapshot",
      );
      await page
        .locator('[data-slot="shared-record-unavailable-leave"]')
        .click();
      await expect(page).toHaveURL(/\/$/);
      await freshDashboard;

      const freshMedications = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/api/medications",
      );
      await page.goto("/medications");
      await freshMedications;
    } finally {
      page.off("request", trackOwnerOnlyRead);
      page.off("request", trackTargetPreload);
      await page.unroute("**/api/auth/me");
    }
  });

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

    await page.reload();
    const payload = await page.evaluate(async () => {
      const response = await fetch("/api/measurements");
      return { status: response.status, body: await response.json() };
    });
    expect(payload.status).toBeLessThan(300);
    expect(JSON.stringify(payload.body)).toContain("124");
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

    await page.goto("/");
    const generatedRead = await page.evaluate(async () => {
      const response = await fetch("/api/dashboard/summary");
      return response.status;
    });
    expect(generatedRead).toBeLessThan(300);
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
