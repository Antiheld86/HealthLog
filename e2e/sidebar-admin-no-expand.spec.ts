import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.16 A1 — Sidebar Admin entry must mirror the Settings entry
 * exactly: a single link with no sub-item expansion in the global
 * sidebar. The maintainer reported in v1.4.15 that the sidebar was auto-expanding
 * admin sub-items on `/admin/*` and the gravatar dropdown felt linked to
 * the sidebar — both unwanted UX. The in-shell `<AdminShell>` already
 * renders its own per-section nav inside the page itself.
 *
 * This spec runs only on the desktop project (Pixel 5 hides the global
 * sidebar entirely).
 */
test.describe("sidebar Admin entry no-expansion", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name === "chromium-mobile",
      "global sidebar is desktop-only (md+)",
    );
  });

  test("on /admin/system-status the sidebar shows ONLY the single Admin link, no sub-list", async ({
    page,
  }) => {
    await page.goto("/admin/system-status", {
      waitUntil: "domcontentloaded",
    });

    // The desktop sidebar is the <aside aria-label="Sidebar"> element.
    // (See `src/components/layout/sidebar-nav.tsx`.) The Admin entry
    // inside it must be the ONLY link starting with `/admin` — there
    // must be no anchor pointing at a sub-route like `/admin/users`.
    const sidebar = page.locator("aside[aria-label]").first();
    await expect(sidebar).toBeVisible();

    const adminLink = sidebar.locator("a[href='/admin']");
    await expect(adminLink).toHaveCount(1);

    // No sub-section anchors inside the sidebar — those belong to
    // `<AdminShell>`'s in-page nav, not the global sidebar.
    const subLinks = sidebar.locator("a[href^='/admin/']:not([href='/admin'])");
    await expect(subLinks).toHaveCount(0);
  });

  test("clicking Admin from /dashboard navigates without flashing a sub-list", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const sidebar = page.locator("aside[aria-label]").first();
    await expect(sidebar).toBeVisible();

    // Pre-click sanity: only the single Admin link is present (no
    // sub-items rendered eagerly).
    await expect(sidebar.locator("a[href='/admin']")).toHaveCount(1);
    await expect(
      sidebar.locator("a[href^='/admin/']:not([href='/admin'])"),
    ).toHaveCount(0);

    await sidebar.locator("a[href='/admin']").click();
    await page.waitForURL(/\/admin(\/|$)/);

    // After navigation the sidebar still shows only the single Admin
    // link — no sub-list expansion.
    await expect(sidebar.locator("a[href='/admin']")).toHaveCount(1);
    await expect(
      sidebar.locator("a[href^='/admin/']:not([href='/admin'])"),
    ).toHaveCount(0);
  });

  test("opening the gravatar user-menu does not expand sidebar admin sub-items", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const sidebar = page.locator("aside[aria-label]").first();
    await expect(sidebar).toBeVisible();

    // The user-menu trigger sits inside the sidebar's user section.
    // It carries `aria-label="User menu"`. Open it and confirm the
    // sidebar admin section is unaffected.
    const userMenu = sidebar.getByRole("button", { name: /user menu/i });
    await userMenu.click();

    // Dropdown is open — but the sidebar's structure is still the
    // single Admin entry, no sub-items.
    await expect(sidebar.locator("a[href='/admin']")).toHaveCount(1);
    await expect(
      sidebar.locator("a[href^='/admin/']:not([href='/admin'])"),
    ).toHaveCount(0);
  });
});
