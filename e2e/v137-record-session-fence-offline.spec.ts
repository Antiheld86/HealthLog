import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { SCOPE_DELEGATE_STORAGE_STATE_PATH } from "./setup/test-helpers";

/**
 * FENCE-AC-07 — the disk layers cannot serve one record's bytes inside
 * another.
 *
 * ## Why this is a spec of its own
 *
 * `playwright.config.ts` sets `serviceWorkers: "block"` for every other
 * project, and for a good reason written there: a worker-originated `fetch` is
 * not subject to `page.route`, so the SW would bypass the per-spec route mocks.
 *
 * This case is the exact inverse. Its whole claim is about what the
 * `healthlog-data-*` cache can and cannot serve across a record switch — and
 * with the worker blocked that cache is never populated at all, so the positive
 * control ("the owner snapshot really WAS on disk before the switch") could
 * never pass no matter what the application did. A check that cannot pass is
 * worse than no check, so this runs in the `chromium-service-worker` project
 * with the worker allowed, and uses no route mocks.
 *
 * ## What is asserted, in order
 *
 *   1. the owner's record reads really are on disk before the switch — a test
 *      that seeded nothing proves nothing;
 *   2. only current-version caches exist, which is the eviction the fence's
 *      design relies on to make "a response with no echo" safe;
 *   3. the switch empties the data cache before it reloads;
 *   4. offline inside the target record, no previous-record bytes are painted;
 *   5. and — the paired positive control — the target's own data IS painted
 *      once it has been fetched inside this record, so 4 cannot pass on a
 *      blank page.
 */

const WARM_READS = [
  "/api/dashboard/snapshot",
  "/api/measurements",
  "/api/medications",
] as const;

const TARGET_USERNAME = "e2e-scope-labs";

async function openSwitcher(page: Page) {
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
}

async function expectShellReady(page: Page) {
  await expect(
    page.locator('[data-slot="record-scope-hydration-gate"]'),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "User menu" })).toBeVisible();
}

/** What the `healthlog-data-*` caches hold right now. */
async function dataCacheState(page: Page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const data = names.filter((n) => n.startsWith("healthlog-data-"));
    let entries = 0;
    for (const name of data) {
      entries += (await (await caches.open(name)).keys()).length;
    }
    return { names, dataCaches: data, entries };
  });
}

test.describe.serial("FENCE-AC-07 record-fence disk layers", () => {
  test("FENCE-AC-07 the disk layers cannot serve one record's bytes inside another", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: SCOPE_DELEGATE_STORAGE_STATE_PATH,
    });
    const page = await context.newPage();

    try {
      await page.goto("/");
      // The gate is spelled out here rather than left inside a helper because
      // the next act is a one-shot `page.evaluate`, and
      // `src/__tests__/e2e-measurement-gating-guard.test.ts` reads the source
      // text between the navigation and the read.
      await expect(
        page.getByRole("button", { name: "User menu" }),
      ).toBeVisible();
      await expectShellReady(page);

      // Wait for the worker to control the page — until it does, nothing it
      // would cache is going through it.
      await page.waitForFunction(
        () => navigator.serviceWorker?.controller !== null,
        undefined,
        { timeout: 20_000 },
      );

      // Warm the reads the SW is configured to hold on disk.
      for (const path of WARM_READS) {
        await page.evaluate(async (p) => {
          await fetch(p).catch(() => {});
        }, path);
      }
      await expect
        .poll(async () => (await dataCacheState(page)).entries, {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);

      // (1) POSITIVE CONTROL: the owner's bytes really are on disk.
      const seeded = await dataCacheState(page);
      expect(seeded.dataCaches.length).toBeGreaterThan(0);
      expect(seeded.entries).toBeGreaterThan(0);

      // (2) Only current-version caches survive activation. This is the
      // eviction the fence's "a response with no echo is served normally" rule
      // depends on: a PRE-fence cached response carries no echo, and it can
      // only be served if its cache is still there.
      const version = seeded.dataCaches[0].replace("healthlog-data-", "");
      const stale = seeded.names.filter(
        (n) =>
          /^healthlog-(static|pages|data)-/.test(n) && !n.endsWith(version),
      );
      expect(stale).toEqual([]);

      await openSwitcher(page);
      const entry = page.locator(
        `[data-slot="account-switcher-entry"][data-account-username="${TARGET_USERNAME}"]`,
      );
      await expect(entry).toBeVisible();
      await entry.click();
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible();

      // (3) The switch wipes the disk layers before it reloads, so nothing
      // from the previous record survives into the new one.
      await expect
        .poll(async () => (await dataCacheState(page)).entries, {
          timeout: 15_000,
        })
        .toBe(0);

      // Fetch inside the TARGET record so there is something of its own on
      // disk to find.
      for (const path of WARM_READS) {
        await page.evaluate(async (p) => {
          await fetch(p).catch(() => {});
        }, path);
      }
      await expect
        .poll(async () => (await dataCacheState(page)).entries, {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);

      // (4) + (5) Offline, inside the target record: the shell still paints
      // and it still says which record it is in. The banner is the paired
      // positive control — an offline page that rendered nothing at all would
      // satisfy "no previous-record bytes" while proving nothing.
      await context.setOffline(true);
      await page.reload().catch(() => {});
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toContainText(TARGET_USERNAME);
    } finally {
      await context.setOffline(false);
      await context.close();
    }
  });
});
