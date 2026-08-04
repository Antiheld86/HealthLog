import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Click a menu trigger and confirm the menu actually opened.
 *
 * A bare `trigger.click()` is a coin flip on a server-rendered page. Playwright
 * clicks as soon as the element is visible, stable and enabled — all three of
 * which are true of markup React has not attached a handler to yet. The click
 * lands, nothing happens, and the next line waits thirty seconds for a menu
 * item that will never appear, because the one click the test had was spent
 * before hydration.
 *
 * `networkidle` does not close that window either: the trigger is in the first
 * HTML, so it is present long before the client bundle finishes. The gate has
 * to be the element's own state, not the network's.
 *
 * The check is on the MENU, not on the trigger, and that detail is the whole
 * reason this file has a comment. Radix marks the rest of the page
 * `aria-hidden` while a menu is open, and Playwright's role locators ignore
 * anything hidden from the accessibility tree — so a trigger found through
 * `getByRole` stops matching the moment the click succeeds. Re-reading its
 * attributes afterwards does not report "not open", it hangs until the test
 * budget runs out, which is a failure that points at the trigger and means the
 * opposite.
 *
 * Retry the click rather than raising a timeout: the problem is a lost event,
 * and waiting longer for a click that was already swallowed does nothing.
 */
export async function openMenu(page: Page, trigger: Locator): Promise<void> {
  // A bare `.click()` carries Playwright's own 30 s actionability wait, so the
  // visibility check that replaces it has to be at least as patient.
  await expect(trigger).toBeVisible({ timeout: 30_000 });

  const menu = page.locator(
    '[role="menu"], [role="dialog"][data-state="open"], [data-slot="capture-picker"]',
  );

  for (let attempt = 0; attempt < 5; attempt++) {
    await trigger.click();
    if (
      await menu
        .first()
        .isVisible()
        .catch(() => false)
    )
      return;
    try {
      await expect(menu.first()).toBeVisible({ timeout: 1_500 });
      return;
    } catch {
      // Swallowed by a not-yet-hydrated trigger. Give the bundle a moment and
      // spend another click. The trigger is re-clicked by locator, so a Radix
      // portal that moved focus does not matter.
      await page.waitForTimeout(250);
    }
  }

  await expect(
    menu.first(),
    "the menu never opened after 5 clicks — the page is most likely still hydrating, and the trigger takes clicks before React attaches",
  ).toBeVisible({ timeout: 5_000 });
}
