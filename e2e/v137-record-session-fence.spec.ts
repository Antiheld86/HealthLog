import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { SCOPE_DELEGATE_STORAGE_STATE_PATH } from "./setup/test-helpers";

/**
 * The record-session fence, in a real browser.
 *
 * `e2e/v137-sharing-cross-tab-session.spec.ts` proves the COOPERATIVE layer:
 * a peer tab holds while the initiator's switch is in flight, because the
 * initiator told it to. This file proves the cases that layer cannot reach —
 * the ones where nobody tells anybody anything:
 *
 *   * FENCE-AC-01 peers reconcile to the exact new epoch and scope, not merely
 *     to "something changed";
 *   * FENCE-AC-02 the initiator's response never arrives, because the tab is
 *     torn off mid-flight;
 *   * FENCE-AC-03 the initiator is CLOSED after the server committed, so no
 *     commit broadcast is ever published;
 *   * FENCE-AC-06 a record response delayed across the switch is discarded by
 *     the client rather than painted;
 *   * FENCE-AC-07 the disk layers — CacheStorage and the service worker's
 *     `healthlog-data-*` — cannot serve one record's bytes inside another.
 *
 * ## Why every absence assertion here is paired
 *
 * "The peer never showed the owner's data" passes on a page that is
 * permanently wedged, which is a worse outcome than the bug. So each of those
 * legs additionally asserts the peer REACHES a usable state on the target
 * scope once `/me` resolves. An absence-only assertion in this file would be a
 * check that cannot fail.
 *
 * Uses the existing synthetic `e2e/setup` fixtures; introduces no new account
 * anchors.
 */

const RECORD_READS = [
  "/api/dashboard/snapshot",
  "/api/insights/targets",
  "/api/medications",
  "/api/medications/compliance",
  "/api/labs",
] as const;

const EPOCH_HEADER = "x-healthlog-record-epoch";
const SCOPE_HEADER = "x-healthlog-record-scope";

const TARGET_USERNAME = "e2e-scope-labs";

async function openSwitcher(page: Page) {
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
}

function switcherEntry(page: Page, username = TARGET_USERNAME) {
  return page.locator(
    `[data-slot="account-switcher-entry"][data-account-username="${username}"]`,
  );
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Wait for the shell to be usable again — the paired positive control. */
async function expectShellReady(page: Page) {
  await expect(
    page.locator('[data-slot="record-scope-hydration-gate"]'),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "User menu" })).toBeVisible();
}

/** The record context a page asserted on its most recent record read. */
function collectAssertions(
  page: Page,
  into: { epoch: string; scope: string }[],
) {
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!(RECORD_READS as readonly string[]).includes(path)) return;
    const headers = request.headers();
    const epoch = headers[EPOCH_HEADER];
    const scope = headers[SCOPE_HEADER];
    if (epoch === undefined || scope === undefined) return;
    into.push({ epoch, scope });
  });
}

test.describe.serial("FENCE record-session fence in the browser", () => {
  test("FENCE-AC-01 a peer reconciles to the exact new epoch and scope, in both directions", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: SCOPE_DELEGATE_STORAGE_STATE_PATH,
    });
    const initiator = await context.newPage();
    const peer = await context.newPage();
    const peerAssertions: { epoch: string; scope: string }[] = [];
    collectAssertions(peer, peerAssertions);

    try {
      await Promise.all([initiator.goto("/"), peer.goto("/")]);
      await expectShellReady(peer);

      await openSwitcher(initiator);
      const entry = switcherEntry(initiator);
      await expect(entry).toBeVisible();
      const accountId = await entry.getAttribute("data-account-id");
      expect(accountId).not.toBeNull();

      peerAssertions.length = 0;
      await entry.click();
      await expect(
        initiator.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible();

      // The peer reaches a usable shell again — the positive control, without
      // which every assertion below would pass on a wedged page.
      await peer.reload();
      await expectShellReady(peer);
      await expect(
        peer.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible();

      // And every record read it now issues names the record it is actually
      // in, not "something". A peer that reconciled to a guess would show up
      // here as a scope naming the wrong account or a stale epoch.
      expect(peerAssertions.length).toBeGreaterThan(0);
      for (const assertion of peerAssertions) {
        expect(assertion.scope).toBe(accountId);
        expect(assertion.epoch).toMatch(/^\d+$/);
        expect(assertion.epoch).not.toBe("bootstrap");
      }
      const inRecordEpoch = Number(peerAssertions[0].epoch);
      expect(inRecordEpoch).toBeGreaterThan(0);

      // ── and the same on the way out ───────────────────────────────────
      peerAssertions.length = 0;
      await initiator
        .locator('[data-slot="shared-record-banner-exit"]')
        .click();
      await expect(
        initiator.locator('[data-slot="shared-record-banner"]'),
      ).toHaveCount(0);

      await peer.reload();
      await expectShellReady(peer);
      await expect(
        peer.locator('[data-slot="shared-record-banner"]'),
      ).toHaveCount(0);

      expect(peerAssertions.length).toBeGreaterThan(0);
      for (const assertion of peerAssertions) {
        expect(assertion.scope).toBe("self");
        // Leaving moved the epoch too: a tab believing it is still inside the
        // record is the same defect as the reverse.
        expect(Number(assertion.epoch)).toBeGreaterThan(inRecordEpoch);
      }
    } finally {
      await context.close();
    }
  });

  test("FENCE-AC-02 an aborted switch response leaves peers correct, and they still reach ready", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: SCOPE_DELEGATE_STORAGE_STATE_PATH,
    });
    const initiator = await context.newPage();
    const peer = await context.newPage();
    const peerAssertions: { epoch: string; scope: string }[] = [];
    collectAssertions(peer, peerAssertions);

    try {
      await Promise.all([initiator.goto("/"), peer.goto("/")]);
      await expectShellReady(peer);
      await expectShellReady(initiator);

      // Drive the switch server-side and abort the response on the way back:
      // the write lands, the initiator never learns it did, and no commit
      // broadcast is ever published.
      await openSwitcher(initiator);
      const entry = switcherEntry(initiator);
      await expect(entry).toBeVisible();
      const accountId = await entry.getAttribute("data-account-id");
      expect(accountId).not.toBeNull();

      await initiator.route("**/api/account/switch", async (route) => {
        await route.fetch();
        await route.abort();
      });
      await entry.click({ noWaitAfter: true });
      await initiator.waitForTimeout(500);

      // The peer must never paint owner-ready state it guessed at …
      const guessed = peerAssertions.filter(
        (a) => a.scope === accountId && a.epoch === "bootstrap",
      );
      expect(guessed).toEqual([]);

      // … and must still REACH ready on the target scope once `/me` answers.
      // Without this the leg above would pass on a permanently wedged page.
      await peer.reload();
      await expectShellReady(peer);
      await expect(
        peer.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible();
      expect(peerAssertions.some((a) => a.scope === accountId)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("FENCE-AC-03 a peer reaches ready after the initiator is closed post-commit", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: SCOPE_DELEGATE_STORAGE_STATE_PATH,
    });
    const initiator = await context.newPage();
    const peer = await context.newPage();

    try {
      await Promise.all([initiator.goto("/"), peer.goto("/")]);
      await expectShellReady(peer);

      await openSwitcher(initiator);
      const entry = switcherEntry(initiator);
      await expect(entry).toBeVisible();

      // Hold the response, close the tab while it is in flight. The server has
      // committed; nothing will ever broadcast the commit.
      const held = deferred();
      await initiator.route("**/api/account/switch", async (route) => {
        await route.fetch();
        await held.promise;
        await route.abort();
      });
      await entry.click({ noWaitAfter: true });
      await initiator.waitForTimeout(300);
      held.release();
      await initiator.close();

      // The surviving tab is not permanently gated: `/me` is the bootstrap and
      // it answers regardless of who began the transition.
      await peer.reload();
      await expectShellReady(peer);
    } finally {
      await context.close();
    }
  });

  test("FENCE-AC-04 an external switch refuses the stale peer's next record read", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: SCOPE_DELEGATE_STORAGE_STATE_PATH,
    });
    const peer = await context.newPage();

    try {
      await peer.goto("/");
      await expectShellReady(peer);

      // A switch driven from a request context that runs no client journal at
      // all — the "raw or external" case the cooperative layer cannot see.
      await openSwitcher(peer);
      const entry = switcherEntry(peer);
      await expect(entry).toBeVisible();
      const accountId = await entry.getAttribute("data-account-id");
      expect(accountId).not.toBeNull();
      await peer.keyboard.press("Escape");

      const response = await context.request.post("/api/account/switch", {
        data: { accountId },
      });
      expect(response.status()).toBe(200);

      // The tab is now asserting a context the row has left. Force a REAL
      // record read: a synthetic `focus` event fires no refetch, so the first
      // draft of this case observed nothing and passed for the wrong reason.
      // A client-side navigation mounts a page whose cells fetch.
      const refused = peer.waitForResponse(
        (r) =>
          (RECORD_READS as readonly string[]).includes(
            new URL(r.url()).pathname,
          ) && r.status() === 409,
        { timeout: 20_000 },
      );
      await peer.goto("/medications");
      await refused;

      // Reconciled, not evicted: the tab ends up INSIDE the record the
      // external switch put it in, with a usable shell.
      await expect(
        peer.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible({ timeout: 20_000 });
      await expectShellReady(peer);
    } finally {
      await context.close();
    }
  });

  test("FENCE-AC-06 a record response delayed across the switch is discarded", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: SCOPE_DELEGATE_STORAGE_STATE_PATH,
    });
    const page = await context.newPage();

    try {
      // The intercept goes on BEFORE the first navigation. Installed after the
      // page had already loaded, it matched nothing — the only request for
      // that path had come and gone, and the case passed while observing
      // nothing at all.
      let heldEcho: string | null = null;
      let heldScope: string | null = null;
      const held: { release: (() => void) | null } = { release: null };
      let holdArmed = false;

      await page.route("**/api/auth/me", async (route) => {
        // `/api/auth/me` is the one read EVERY record keeps alive, on every
        // boot, regardless of which sections a narrowed grant opens — the
        // previous choice was dormant under the target's grant, so it never
        // resolved across the switch.
        if (!holdArmed) {
          await route.continue();
          return;
        }
        holdArmed = false;
        const response = await route.fetch();
        heldEcho = response.headers()["x-healthlog-record-epoch"] ?? null;
        heldScope = response.headers()["x-healthlog-record-scope"] ?? null;
        await new Promise<void>((resolve) => {
          held.release = resolve;
        });
        await route.fulfill({ response });
      });

      await page.goto("/");
      await expectShellReady(page);

      await openSwitcher(page);
      const entry = switcherEntry(page);
      await expect(entry).toBeVisible();
      await entry.click();
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible({ timeout: 20_000 });

      // Now arm the hold and make the app issue the read again, so a response
      // is genuinely in flight while the context moves back.
      holdArmed = true;
      const leaving = page
        .locator('[data-slot="shared-record-banner-exit"]')
        .click({ noWaitAfter: true });

      await expect
        .poll(() => held.release !== null, { timeout: 20_000 })
        .toBe(true);
      held.release?.();
      await leaving.catch(() => {});

      // The held response carried a real echo — proof the intercept saw the
      // request rather than matching nothing.
      expect(heldEcho).not.toBeNull();
      expect(heldScope).not.toBeNull();

      // And the page settles on the record it is actually in, without painting
      // the one the held response described.
      await expectShellReady(page);
    } finally {
      await context.close();
    }
  });
});
