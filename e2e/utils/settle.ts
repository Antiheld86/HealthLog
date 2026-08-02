import { expect, type Locator, type Page } from "@playwright/test";

/**
 * How long either settle wait in `settleBeforeMeasure` may take before the
 * spec moves on.
 *
 * Both of those waits are written to end on their own terms; neither was
 * bounded, and neither inherits a bound from anywhere, because the config
 * leaves `actionTimeout` and `navigationTimeout` unset and Playwright reads
 * that as "no limit". One request that never completes therefore ends the
 * whole test instead of just the wait, and it ends it in the least useful way
 * available: the run reports whichever call was still pending when the fixture
 * tore the page down, so the message names a `page.evaluate` against a closed
 * target rather than the surface that stalled. Six seconds is an order of
 * magnitude above the slowest settle measured anywhere in this suite. Past
 * that it is a stall, and a stall belongs in front of the spec's own
 * assertions, which can say what is actually wrong.
 */
const SETTLE_BUDGET_MS = 6_000;

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
  await page
    .waitForLoadState("networkidle", { timeout: SETTLE_BUDGET_MS })
    .catch(() => {});
  await waitForFonts(page);
}

/**
 * Wait for webfonts to settle, bounded inside the page.
 *
 * `document.fonts.ready` belongs to the document, so awaiting it from a
 * `page.evaluate` hands the test an unbounded wait on a promise no timeout
 * reaches. Race it against a timer in the page instead, so a font that never
 * arrives costs this wait and nothing else.
 */
export async function waitForFonts(
  page: Page,
  timeout = SETTLE_BUDGET_MS,
): Promise<void> {
  await page.evaluate(async (budget: number) => {
    const ready = document.fonts?.ready;
    if (!ready) return;
    await Promise.race([
      ready,
      new Promise((resolve) => window.setTimeout(resolve, budget)),
    ]);
  }, timeout);
}
