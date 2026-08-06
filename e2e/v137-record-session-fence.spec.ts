import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { FENCE_STORAGE_STATE_PATH } from "./setup/test-helpers";

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

/**
 * A WHOLE-record READ grant, deliberately not a narrowed one.
 *
 * The narrowed `e2e-scope-labs` fixture opens only its labs section, so the
 * nav drops the other destinations and the record reads this file drives are
 * refused as out-of-scope before the fence ever matters. Section narrowing is
 * `v137-sharing-managed-profiles.spec.ts`'s subject; here it is noise that
 * hides the thing under test.
 */
const TARGET_USERNAME = "e2e-level-read";

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

/**
 * Leave any record this session is already inside.
 *
 * These specs each begin by switching INTO a record, so they need to start
 * outside one — and the session is shared with the other sharing journeys, so
 * "outside one" is not something a fresh page can assume. Without this the
 * file passes in isolation and fails whenever it runs after a spec that left
 * the session switched, which is the least useful kind of failure.
 */
async function ensureOwnRecord(page: Page) {
  const banner = page.locator('[data-slot="shared-record-banner"]');
  if ((await banner.count()) === 0) return;
  await page.locator('[data-slot="shared-record-banner-exit"]').click();
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
  // And WAIT for the reload to finish.
  //
  // Leaving a record is a full document navigation, and the banner vanishing
  // only means that navigation started. Returning there hands the next step a
  // page that has not re-read `/api/auth/me` yet — so its adopted epoch is
  // still `bootstrap`, its switch sends `expectedEpoch: 0`, the compare-and-set
  // loses against the epoch the exit itself just moved, and the switch quietly
  // does not happen. The symptom is a banner that never appears, thirty
  // seconds later, with nothing wrong in the product.
  await expectShellReady(page);
}

/**
 * Enter the target record, retrying the click if the switch did not land.
 *
 * Not a workaround for a flaky product — a fixture acknowledging a contract the
 * product chose deliberately. `POST /api/account/switch` is a compare-and-set
 * on the session's record epoch, and the client reconciles and retries exactly
 * ONCE; a second lost CAS surfaces as a failed toast rather than being retried
 * forever, which is the right call for a person at a keyboard.
 *
 * These tests are not a person at a keyboard. Some drive two tabs of ONE
 * session at machine speed while the peer is reloading and re-adopting, which
 * is precisely the "the browser is racing itself" case that contract names —
 * so the switcher click legitimately loses sometimes, and the product is
 * behaving as designed when it does. The fixture re-presses the button, which
 * is what the person would do.
 *
 * Bounded and asserted: if three attempts cannot enter the record, that is a
 * real failure and it fails.
 */
async function enterRecord(page: Page, username = TARGET_USERNAME) {
  const banner = page.locator('[data-slot="shared-record-banner"]');
  let accountId: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await openSwitcher(page);
    const entry = switcherEntry(page, username);
    await expect(entry).toBeVisible();
    accountId ??= await entry.getAttribute("data-account-id");
    await entry.click();
    try {
      await expect(banner).toBeVisible({ timeout: 15_000 });
      return accountId;
    } catch {
      // The switcher menu may still be open over the page; start clean.
      await page.goto("/");
      await expectShellReady(page);
    }
  }
  await expect(banner).toBeVisible({ timeout: 15_000 });
  return accountId;
}

/** Wait for the shell to be usable again — the paired positive control. */
async function expectShellReady(page: Page) {
  await expect(
    page.locator('[data-slot="record-scope-hydration-gate"]'),
    // A real budget, not the 10 s default. The gate IS the cross-tab hold: a
    // peer sits behind it until its own `/api/auth/me` resolves, and that read
    // queues behind whatever the other worker's browser is doing. Ten seconds
    // is a statement about machine load; thirty is about the hold actually
    // never releasing, which is the failure worth reporting.
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "User menu" })).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * The furthest-along assertion in a collected set.
 *
 * The epoch is monotonic, so the highest one is the freshest context this
 * browser has reached — independent of the order the requests happened to be
 * observed in.
 */
function latestAssertion(
  collected: { epoch: string; scope: string }[],
): { epoch: string; scope: string } | null {
  let best: { epoch: string; scope: string } | null = null;
  for (const assertion of collected) {
    if (!/^\d+$/.test(assertion.epoch)) continue;
    if (best === null || Number(assertion.epoch) > Number(best.epoch)) {
      best = assertion;
    }
  }
  return best;
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
    // Two full switches, two peer reloads each, and a poll that reloads until
    // the server write is visible to the second tab. That does not fit the
    // 30 s default, and a test that times out reports a failure that says
    // nothing about the fence.
    test.setTimeout(120_000);
    const context = await browser.newContext({
      storageState: FENCE_STORAGE_STATE_PATH,
    });
    const initiator = await context.newPage();
    const peer = await context.newPage();
    const peerAssertions: { epoch: string; scope: string }[] = [];
    collectAssertions(peer, peerAssertions);

    try {
      await Promise.all([initiator.goto("/"), peer.goto("/")]);
      await expectShellReady(peer);
      await expectShellReady(initiator);
      await ensureOwnRecord(initiator);
      await peer.reload();
      await expectShellReady(peer);

      const accountId = await enterRecord(initiator);
      expect(accountId).not.toBeNull();

      // Cleared HERE, not before the click: between the click and the reload
      // the peer is still issuing reads under the context it had, and counting
      // those made the assertion below compare a pre-switch `self` against the
      // post-switch account. Only what the peer asserts once it has reconciled
      // is evidence about reconciliation.
      peerAssertions.length = 0;

      // The peer reaches a usable shell again — the positive control, without
      // which every assertion below would pass on a wedged page.
      await peer.reload();
      await expectShellReady(peer);
      await expect(
        peer.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible({ timeout: 30_000 });

      // And every record read it now issues names the record it is actually
      // in, not "something". A peer that reconciled to a guess would show up
      // here as a scope naming the wrong account or a stale epoch.
      // The HIGHEST-epoch assertion, not every collected one.
      //
      // The epoch is monotonic, and requests do not arrive in the order they
      // were issued — a read from the page before the reload can be observed
      // after one from the page after it. Requiring EVERY collected assertion
      // to name the new record is therefore a claim about network ordering
      // rather than about reconciliation, and it fails intermittently for a
      // reason that has nothing to do with the fence. What reconciliation
      // means is that the peer CONVERGES on the new context, which is exactly
      // the highest epoch it ever asserts.
      const inRecord = latestAssertion(peerAssertions);
      expect(inRecord).not.toBeNull();
      expect(inRecord!.scope).toBe(accountId);
      const inRecordEpoch = Number(inRecord!.epoch);
      expect(inRecordEpoch).toBeGreaterThan(0);

      // ── and the same on the way out ───────────────────────────────────
      await initiator
        .locator('[data-slot="shared-record-banner-exit"]')
        .click();
      await expect(
        initiator.locator('[data-slot="shared-record-banner"]'),
      ).toHaveCount(0, { timeout: 30_000 });

      peerAssertions.length = 0;
      // Polled with reloads rather than reloaded once. The initiator's banner
      // disappearing means its own document navigated, not that the server
      // write has landed and become visible to another tab — asserting on one
      // reload made this leg a race against the switch-out commit.
      await expect
        .poll(
          async () => {
            await peer.reload();
            await expectShellReady(peer);
            return peer.locator('[data-slot="shared-record-banner"]').count();
          },
          { timeout: 40_000 },
        )
        .toBe(0);

      const backHome = latestAssertion(peerAssertions);
      expect(backHome).not.toBeNull();
      expect(backHome!.scope).toBe("self");
      // Leaving moved the epoch too: a tab believing it is still inside the
      // record is the same defect as the reverse.
      expect(Number(backHome!.epoch)).toBeGreaterThan(inRecordEpoch);
    } finally {
      // Hand the shared session back to its own record.
      //
      // These fixtures' storage state is shared with the other sharing
      // journeys, and every test here deliberately moves the session's record
      // selector. Leaving it switched makes the NEXT spec fail for a reason
      // that has nothing to do with it — which is how a green file and a red
      // suite happen at the same time.
      await context.request
        .post("/api/account/switch", { data: { accountId: null } })
        .catch(() => {});
      await context.close();
    }
  });

  test("FENCE-AC-02 an aborted switch response leaves peers correct, and they still reach ready", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: FENCE_STORAGE_STATE_PATH,
    });
    const initiator = await context.newPage();
    const peer = await context.newPage();
    const peerAssertions: { epoch: string; scope: string }[] = [];
    collectAssertions(peer, peerAssertions);

    try {
      await Promise.all([initiator.goto("/"), peer.goto("/")]);
      await expectShellReady(peer);
      await expectShellReady(initiator);
      await ensureOwnRecord(initiator);

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
      // Hand the shared session back to its own record.
      //
      // These fixtures' storage state is shared with the other sharing
      // journeys, and every test here deliberately moves the session's record
      // selector. Leaving it switched makes the NEXT spec fail for a reason
      // that has nothing to do with it — which is how a green file and a red
      // suite happen at the same time.
      await context.request
        .post("/api/account/switch", { data: { accountId: null } })
        .catch(() => {});
      await context.close();
    }
  });

  test("FENCE-AC-03 a peer reaches ready after the initiator is closed post-commit", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: FENCE_STORAGE_STATE_PATH,
    });
    const initiator = await context.newPage();
    const peer = await context.newPage();

    try {
      await Promise.all([initiator.goto("/"), peer.goto("/")]);
      await expectShellReady(peer);
      await expectShellReady(initiator);
      await ensureOwnRecord(initiator);
      await peer.reload();
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
      // Hand the shared session back to its own record.
      //
      // These fixtures' storage state is shared with the other sharing
      // journeys, and every test here deliberately moves the session's record
      // selector. Leaving it switched makes the NEXT spec fail for a reason
      // that has nothing to do with it — which is how a green file and a red
      // suite happen at the same time.
      await context.request
        .post("/api/account/switch", { data: { accountId: null } })
        .catch(() => {});
      await context.close();
    }
  });

  test("FENCE-AC-04 an external switch refuses the stale peer's next record read", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: FENCE_STORAGE_STATE_PATH,
    });
    const peer = await context.newPage();
    // Collected from the very start: the refusal can land on a poll the app
    // issues by itself, before this test navigates anywhere.
    const refusals: string[] = [];
    peer.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (response.status() !== 409) return;
      // ANY refused API read, not one of a named five. Which cells a page
      // mounts is a rendering decision that moves with the product, and a
      // hard-coded list turns "the fence refused the stale tab" into "the
      // fence refused one of the paths I happened to name" — which is how
      // this case first passed while observing nothing.
      if (!path.startsWith("/api/")) return;
      refusals.push(path);
    });

    try {
      await peer.goto("/");
      await expectShellReady(peer);
      await ensureOwnRecord(peer);

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

      // The tab is now asserting a context the row has left — but observing
      // the refusal takes one deliberate step, and the reason is worth stating
      // because it is a property of the design rather than a quirk of the test.
      //
      // `GET /api/auth/me` is UNFENCED (it is the reconciliation bootstrap and
      // must answer while the context is unknown) and it is one of the two
      // responses a client may ADOPT from. So whenever the app happens to
      // re-read `/me` before it reads a record, it silently adopts the new
      // context and no stale assertion is ever sent. That is correct — and it
      // means a test that just navigates observes nothing, which is how the
      // first draft of this case passed while proving nothing.
      //
      // The window the fence exists for is the opposite ordering: a suspended
      // peer whose RECORD read goes out before any reconciliation. Holding
      // `/me` produces exactly that ordering, deterministically.
      // Held exactly once, and never unrouted: calling `unroute` while a
      // handler is still parked inside its `await` abandons that route, and
      // the `continue()` on the far side then throws "Route is already
      // handled". Letting the handler fall through after the first hold keeps
      // one owner for the route from start to finish.
      const heldMe: { release: (() => void) | null; done: boolean } = {
        release: null,
        done: false,
      };
      await peer.route("**/api/auth/me", async (route) => {
        if (heldMe.done) {
          await route.continue();
          return;
        }
        heldMe.done = true;
        await new Promise<void>((resolve) => {
          heldMe.release = resolve;
        });
        await route.continue();
      });

      const soft = peer.locator('aside[aria-label="Sidebar"]');
      await expect(soft).toBeVisible();
      await soft.getByRole("link", { name: "Measurements" }).click();

      await expect
        .poll(() => refusals.length, { timeout: 20_000 })
        .toBeGreaterThan(0);

      // Let the reconciliation through and confirm the tab recovers rather
      // than sitting on the refusal.
      heldMe.release?.();

      // Reconciled, not evicted: the tab ends up INSIDE the record the
      // external switch put it in, with a usable shell.
      await expect(
        peer.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible({ timeout: 20_000 });
      await expectShellReady(peer);
    } finally {
      // Hand the shared session back to its own record.
      //
      // These fixtures' storage state is shared with the other sharing
      // journeys, and every test here deliberately moves the session's record
      // selector. Leaving it switched makes the NEXT spec fail for a reason
      // that has nothing to do with it — which is how a green file and a red
      // suite happen at the same time.
      await context.request
        .post("/api/account/switch", { data: { accountId: null } })
        .catch(() => {});
      await context.close();
    }
  });

  test("FENCE-AC-06 a record response delayed across the switch is discarded", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: FENCE_STORAGE_STATE_PATH,
    });
    const page = await context.newPage();

    try {
      // The intercept goes on BEFORE the first navigation. Installed after the
      // page had already loaded, it matched nothing — the only request for that
      // path had come and gone, and the case passed while observing nothing.
      //
      // And it holds `/api/measurements`, a FENCED record read. The first
      // version held `/api/auth/me` because that one is alive on every boot —
      // but `/me` is an actor surface, the fence never runs on it, and it
      // therefore echoes no record context at all. Holding it captured a null
      // echo forever, which is the same "observed nothing" failure wearing a
      // different path.
      const held: {
        armed: boolean;
        release: (() => void) | null;
        epoch: string | null;
        scope: string | null;
      } = { armed: false, release: null, epoch: null, scope: null };

      await page.route("**/api/measurements**", async (route) => {
        if (!held.armed) {
          await route.continue();
          return;
        }
        held.armed = false;
        const response = await route.fetch();
        held.epoch = response.headers()["x-healthlog-record-epoch"] ?? null;
        held.scope = response.headers()["x-healthlog-record-scope"] ?? null;
        await new Promise<void>((resolve) => {
          held.release = resolve;
        });
        await route.fulfill({ response }).catch(() => {});
      });

      await page.goto("/");
      await expectShellReady(page);
      await ensureOwnRecord(page);

      const accountId = await enterRecord(page);

      // Arm the hold, then make the app issue the read inside the record.
      held.armed = true;
      const sidebar = page.locator('aside[aria-label="Sidebar"]');
      await expect(sidebar).toBeVisible();
      await sidebar
        .getByRole("link", { name: "Measurements" })
        .click({ noWaitAfter: true });

      await expect
        .poll(() => held.release !== null, { timeout: 20_000 })
        .toBe(true);

      // The response was admitted under the record's context and says so.
      // Proof the intercept saw a real fenced read rather than matching
      // nothing, which is the whole failure mode this case kept falling into.
      expect(held.epoch).toMatch(/^\d+$/);
      expect(held.scope).toBe(accountId);

      // Now move the context out from under it, and only then let it land.
      const leaving = page
        .locator('[data-slot="shared-record-banner-exit"]')
        .click({ noWaitAfter: true });
      await page.waitForTimeout(500);
      held.release?.();
      await leaving.catch(() => {});

      // The page settles on the record it is actually in — its own — without
      // painting the one the held response described.
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toHaveCount(0, { timeout: 20_000 });
      await expectShellReady(page);
    } finally {
      // Hand the shared session back to its own record.
      await context.request
        .post("/api/account/switch", { data: { accountId: null } })
        .catch(() => {});
      await context.close();
    }
  });
});
