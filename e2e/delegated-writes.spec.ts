/**
 * A delegate who may write: what they are offered, and what they are not.
 *
 * The unit suite runs SSR-only, so it holds the PAINT and never the click: it
 * can prove an add button is absent, which is the property that matters most,
 * and it cannot prove that the one still standing submits. This spec is the
 * other half — a real form, a real POST, a real row in somebody else's record,
 * and the owner seeing it afterwards.
 *
 * ## Why it gates itself instead of seeding a WRITE grant directly
 *
 * The grant level is chosen in the invitation form, which is another chunk's
 * work. Rather than mint a WRITE row behind the UI's back — which would prove
 * the journey works for a grant no person can create — the journey looks for
 * the level control and stands down when it is not there yet.
 *
 * **To enable this once the invite form ships its level control:** if it lands
 * under a different `data-slot` than the constant below, change that one
 * string. Nothing else in this file assumes anything about the control except
 * that picking WRITE and submitting mints a WRITE grant.
 *
 * The skip is deliberately loud rather than silent: it names the missing
 * control, so a run where the control exists and the journey still does not
 * execute reads as a bug in this file rather than as an absence upstream.
 *
 * ## What this spec cannot cover
 *
 * The owner's activity view is asserted at the level of "a row appeared for
 * something the delegate did", not at the level of the per-verb sentence. The
 * verb lines live in `src/lib/record-activity/activity-verb.ts` with their own
 * unit test; the one line that binds them into the activity card belongs to
 * the file this chunk was told not to touch.
 */
import type { BrowserContext, Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import {
  DELEGATE_STORAGE_STATE_PATH,
  E2E_OWNER,
  E2E_USER,
  OWNER_STORAGE_STATE_PATH,
} from "./setup/test-helpers";

/**
 * The invitation form's grant-level control. The journey runs when this is on
 * the page and stands down when it is not. One string, one place.
 */
const GRANT_LEVEL_SLOT = "grant-invite-level";

/** The value the level control carries for a grant that may add entries. */
const WRITE_LEVEL_VALUE = "write";

test.describe("delegated writes", () => {
  // One journey in order, like the read-only sibling: each step is the next
  // one's precondition, and the invitation endpoint is rate-limited.
  test.describe.configure({ mode: "serial" });

  // The `page` fixture is the DELEGATE throughout, on this journey's own
  // cookie jar — the switch is stamped on the session row, so switching a
  // shared jar would switch it for every spec holding the same cookie.
  test.use({ storageState: DELEGATE_STORAGE_STATE_PATH });

  // Desktop only: the journey mutates shared rows between two seeded accounts,
  // so two projects running it at once race each other and the second
  // invitation is refused as a duplicate.
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "shared-fixture journey — runs once",
    );
  });

  let ownerContext: BrowserContext;
  let ownerPage: Page;
  let levelControlPresent = false;

  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext({
      storageState: OWNER_STORAGE_STATE_PATH,
    });
    ownerPage = await ownerContext.newPage();
    await ownerPage.goto("/settings/access");
    levelControlPresent =
      (await ownerPage.locator(`[data-slot="${GRANT_LEVEL_SLOT}"]`).count()) >
      0;
  });

  test.afterAll(async () => {
    await ownerContext.close();
  });

  test.beforeEach(() => {
    test.skip(
      !levelControlPresent,
      `no [data-slot="${GRANT_LEVEL_SLOT}"] in the invitation form — a WRITE grant cannot be created through the UI yet`,
    );
  });

  test("the owner invites at a level that may add entries", async () => {
    await ownerPage.goto("/settings/access");

    const identifier = ownerPage.locator(
      '[data-slot="grant-invite-identifier"]',
    );
    const submit = ownerPage.locator('[data-slot="grant-invite-submit"]');
    // The controlled input keeps the submit disabled until React has attached,
    // so retry the pair rather than waiting a fixed time and hoping.
    await expect(async () => {
      await identifier.fill(E2E_USER.username);
      await expect(submit).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });

    await ownerPage
      .locator(`[data-slot="${GRANT_LEVEL_SLOT}"]`)
      .selectOption(WRITE_LEVEL_VALUE);

    // Read the posted body: a level control that renders and sends a hardcoded
    // level would pass every render assertion and ship a read-only grant.
    const invitePost = ownerPage.waitForRequest(
      (req) =>
        req.method() === "POST" && req.url().endsWith("/api/account/grants"),
    );
    await submit.click();
    const posted = JSON.parse((await invitePost).postData() ?? "{}") as {
      access?: string;
    };
    expect(
      posted.access?.toLowerCase(),
      "the invitation must carry the level the owner chose",
    ).toBe(WRITE_LEVEL_VALUE);
  });

  test("the delegate accepts and opens the record", async ({ page }) => {
    await page.goto("/settings/access");
    await page.locator('[data-slot="grant-accept"]').first().click();

    // The switcher lives inside the user menu, like its read-only sibling.
    await page.getByRole("button", { name: "User menu" }).first().click();
    await page.locator('[data-slot="account-switcher-trigger"]').click();
    await expect(
      page.locator('[data-slot="account-switcher-menu"]'),
    ).toBeVisible();
    await page.locator('[data-slot="account-switcher-entry"]').click();

    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(E2E_OWNER.username);
    // The banner drops its read-only clause on its own once the level says so.
    await expect(banner).not.toContainText("read it, not change it");
  });

  test("the reading they add lands in the owner's record", async ({ page }) => {
    await page.goto("/measurements");
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toBeVisible();

    // The add path survives at WRITE. This is the click an SSR test cannot
    // make: the button rendering and the button working are two facts.
    const post = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        res.url().endsWith("/api/measurements"),
    );
    await page.getByRole("button", { name: /add measurement/i }).click();
    await page.locator('input[name="value"], #value').first().fill("71.5");
    await page.getByRole("button", { name: /^save$/i }).click();
    expect((await post).status(), "the write must be accepted").toBeLessThan(
      300,
    );

    // And the row it created is not theirs to change. Absent, not disabled:
    // a `toBeDisabled()` assertion here would pass against the exact design
    // this release exists to avoid.
    await expect(
      page.locator('[data-slot="selection-action-bar"]'),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^delete$/i })).toHaveCount(
      0,
    );
  });

  test("a deep link opens exactly what the level admits", async ({ page }) => {
    // The gate binds to the level the server resolved, not to a blanket
    // "somebody else's record" flag. Both halves matter and only a browser
    // can show either: the SSR suite holds a component's paint, never a URL.
    //
    // Admitted: entering a reading, so `?add=` opens the same sheet the
    // header button opens.
    await page.goto("/measurements?add=WEIGHT");
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="responsive-sheet-content"]').first(),
    ).toBeVisible();

    // Also admitted: adding a medication with its schedule.
    await page.goto("/medications?new=1");
    await expect(
      page.locator('[data-slot="medication-wizard-dialog"]'),
    ).toBeVisible();
  });

  test("the owner sees that somebody else was in their record", async () => {
    await ownerPage.goto("/settings/access");
    const rows = ownerPage.locator('[data-slot="record-activity-row"]');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toContainText(E2E_USER.username);
  });
});
