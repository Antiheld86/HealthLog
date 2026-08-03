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
 * This is the failure that took two branches to read: the quick-add trigger on
 * the dashboard, clicked, no menu in the failure snapshot, and no defect in the
 * component. It surfaces when the machine is loaded — a heavier suite is enough
 * to push hydration past the click — so it reads as a branch-specific
 * regression when it is a race the spec always had.
 *
 * The signal is the trigger's own open state. Radix stamps `data-state="open"`;
 * a hand-rolled trigger carries `aria-expanded="true"` off React state. Either
 * one only appears once a handler ran, which is exactly the thing being waited
 * for. Retry the click rather than raising a timeout: the problem is a lost
 * event, and waiting longer for a click that was already swallowed does
 * nothing.
 */
export async function openMenu(page: Page, trigger: Locator): Promise<void> {
  await expect(trigger).toBeVisible();

  for (let attempt = 0; attempt < 5; attempt++) {
    await trigger.click();
    if (await isOpen(trigger)) return;
    // Swallowed by a not-yet-hydrated trigger. Give the bundle a moment and
    // spend another click.
    await page.waitForTimeout(250);
  }

  // Out of attempts. Fail naming the state the trigger was actually in, rather
  // than letting the caller time out on a menu item that was never going to
  // appear.
  const state = await trigger.getAttribute("data-state");
  const expanded = await trigger.getAttribute("aria-expanded");
  throw new Error(
    `openMenu: the trigger never opened after 5 clicks (data-state=${state}, aria-expanded=${expanded}). ` +
      "The page is most likely still hydrating; the trigger is in the server HTML and takes clicks before React attaches.",
  );
}

async function isOpen(trigger: Locator): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    const [state, expanded] = await Promise.all([
      trigger.getAttribute("data-state"),
      trigger.getAttribute("aria-expanded"),
    ]);
    if (state === "open" || expanded === "true") return true;
    await trigger.page().waitForTimeout(100);
  }
  return false;
}
