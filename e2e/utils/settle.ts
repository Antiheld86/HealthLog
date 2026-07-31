import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Gate a one-shot DOM read on the element it is about to measure.
 *
 * The failure this exists to prevent: a spec navigates with
 * `waitUntil: "networkidle"`, then reads the DOM in a single
 * `page.evaluate` / `evaluateAll` that does not retry. An idle network says
 * nothing about whether React has rendered, so the read can land on a tree
 * that is still mounting and the assertion then blames the application for
 * something the test raced — "language + dob fields must exist" when the
 * fields were simply not there yet, or a measurement helper accused of
 * measuring the wrong element when it was measuring the right one too early.
 *
 * Two such tests went red on consecutive CI runs during v1.33.0. Neither
 * reproduces locally: a developer machine is fast enough that the render
 * always wins the race, so the only place this shows up is a loaded runner,
 * and `failOnFlakyTests` means every occurrence costs a whole red pipeline
 * even when the retry passes.
 *
 * `sentinel` must be something the measurement actually depends on, not just
 * any element on the page. Gating on a layout shell that renders before the
 * data proves nothing.
 */
export async function settleBeforeMeasure(
  page: Page,
  sentinel: Locator,
  options: { attachedOnly?: boolean } = {},
): Promise<void> {
  if (options.attachedOnly) {
    await expect(sentinel).toBeAttached();
  } else {
    await expect(sentinel).toBeVisible();
  }
  // A shell can be visible while the data underneath it is still arriving,
  // and a placeholder standing in for that data occupies height like any
  // other content. Measuring then reports the geometry of a page that no
  // longer exists a moment later, and blames the application for it. The
  // suite marks those placeholders with a `-loading` slot, so wait for them
  // to go. Never fail on the wait: a page that legitimately keeps one would
  // otherwise turn every measurement on it into a timeout, which is a worse
  // failure than the one being prevented.
  await expect(page.locator('[data-slot$="-loading"]'))
    .toHaveCount(0, { timeout: 5_000 })
    .catch(() => {});
  // Fonts and late CSS change geometry after the element is visible, and
  // every measurement in this suite is geometric.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts?.ready);
}
