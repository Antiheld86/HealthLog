import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.19 phase A5 — `/settings/integrations` on a Pixel-5 viewport
 * (393 CSS px) must:
 *
 *   1. Not produce horizontal page overflow. The new
 *      IntegrationStatusPill is `whitespace-nowrap` so the chip
 *      itself can grow as wide as its longest possible label
 *      ("Verbunden · vor 12 min" / "Error — reconnect"); the parent
 *      header is a `flex-wrap` so the pill drops to its own line if
 *      the title and pill together exceed the card width — this spec
 *      verifies neither path leaks into a horizontal scrollbar on the
 *      <html> element.
 *
 *   2. Render exactly one pill per integration card. Belt-and-braces
 *      guard for the card consolidation — the Vitest spec covers this
 *      on the SSR markup level, but the Pixel-5 layout is what matters
 *      in practice.
 *
 * Mobile-only spec — desktop project skips it.
 */
test.describe("/settings/integrations Pixel-5 layout", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("Pixel-5 viewport: no horizontal page scroll, one pill per card", async ({
    page,
  }) => {
    // Stub the three endpoints the Integrations section reads — both
    // integrations connected, recent sync — so the cards render their
    // post-connect branch (the visually densest layout).
    await page.route("**/api/settings/global-services", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            telegramGlobal: true,
            ntfyGlobal: true,
            webPushGlobal: true,
            apiGlobal: true,
          },
          error: null,
        }),
      }),
    );

    const recent = new Date(Date.now() - 12 * 60 * 1000).toISOString();
    const monthAgo = new Date(
      Date.now() - 28 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await page.route("**/api/integrations/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            threshold: 3,
            integrations: [
              {
                integration: "withings",
                state: "connected",
                lastSuccessAt: recent,
                lastAttemptAt: recent,
                lastError: null,
                consecutiveFailures: 0,
                // v1.12.1 — the cards read connection state from this
                // consolidated envelope (the per-provider routes were
                // dropped from the section). The Withings pill keys on
                // `connected`; a card-less pill keys on `configured`.
                configured: true,
                connected: true,
                connectedAt: "2026-04-01T12:00:00Z",
                legacyLastSyncedAt: recent,
                tokenExpiresAt: "2026-12-01T12:00:00Z",
                tokenExpired: false,
                scope: "user.info,user.metrics,user.activity",
                hasActivityScope: true,
                syncHealth: { verdict: "fresh", since: null },
                metricFreshness: [
                  { type: "WEIGHT", lastSeenAt: recent, stale: false },
                ],
              },
              {
                // Configured, card-less, and no longer attempting: the case
                // the fallback row exists for. Synthetic since v1.32.33 —
                // every shipped provider has a card again, and the row must
                // stay proven before the next one is dropped.
                integration: "example-provider",
                state: "connected",
                lastSuccessAt: recent,
                lastAttemptAt: recent,
                lastError: null,
                consecutiveFailures: 0,
                configured: true,
                legacyLastSyncedAt: monthAgo,
                syncHealth: { verdict: "stalled", since: monthAgo },
                metricFreshness: [],
              },
              // v1.28.x — Strava OAuth card reads off this consolidated
              // envelope; without a `strava` entry the new card's query key
              // never resolves and the integrations page hangs.
              {
                integration: "strava",
                state: "disconnected",
                lastSuccessAt: null,
                lastAttemptAt: null,
                lastError: null,
                connected: false,
                configured: false,
                available: false,
                hasOwnCredentials: false,
                syncHealth: { verdict: "disconnected", since: null },
                metricFreshness: [],
              },
              // Nightscout reads the envelope too since the card dropped its
              // own status round-trip; without an entry its pill never resolves.
              {
                integration: "nightscout",
                state: "disconnected",
                lastSuccessAt: null,
                lastAttemptAt: null,
                lastError: null,
                connected: false,
                configured: false,
                hasToken: false,
                allowPrivateHost: false,
                syncHealth: { verdict: "disconnected", since: null },
                metricFreshness: [],
              },
            ],
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/withings/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            connected: true,
            configured: true,
            lastSyncedAt: recent,
            connectedAt: "2026-04-01T12:00:00Z",
            tokenExpired: false,
          },
          error: null,
        }),
      }),
    );

    await page.goto("/settings/integrations", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle");

    // Wait for the pills to mount (queries resolve after first paint).
    // One pill per card: Withings, WHOOP, Fitbit, Google Health, Polar,
    // Oura, Strava, Nightscout — plus the fallback row for the configured,
    // card-less entry. (The Garmin info note is not an OAuth card and
    // carries no pill; the Apple Health card's pill keeps its own testid.)
    const pills = page.locator('[data-testid="integration-status-pill"]');
    await expect(pills).toHaveCount(9, { timeout: 10_000 });

    // The acceptance case: a configured integration with no card of its own,
    // which has stopped even attempting, is visible on the page.
    const fallback = page.locator(
      '[data-testid="integration-fallback-row"][data-integration="example-provider"]',
    );
    await expect(fallback).toHaveCount(1);
    await expect(
      fallback.locator('[data-testid="integration-status-pill"]'),
    ).toHaveAttribute("data-state", "stalled");

    // Card anatomy is uniform because no integration card paints a rule under
    // its header any more. The `<hr>` existed only in this folder — nine cards
    // carrying a separator no other Settings card has — and the card's own gap
    // does the separating now.
    await expect(
      page.locator('[data-testid="integration-card-divider"]'),
    ).toHaveCount(0);

    // Withings is connected in this fixture; WHOOP is a BYO-keys card that
    // stays dormant until an operator adds credentials, so assert the one
    // connected pill.
    await expect(
      page.locator(
        '[data-testid="integration-status-pill"][data-state="connected"]',
      ),
    ).toHaveCount(1);

    // The redundant v1.4.18 banner must be gone.
    await expect(
      page.locator('[data-testid="integration-status-banner"]'),
    ).toHaveCount(0);

    // No horizontal page overflow. We allow a 1 px tolerance because
    // sub-pixel rounding can flag a 0.5 px overshoot as 1 px.
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      dims.scrollWidth,
      `scrollWidth=${dims.scrollWidth}, innerWidth=${dims.innerWidth}`,
    ).toBeLessThanOrEqual(dims.innerWidth + 1);

    // Pill text remains legible at this viewport — assert non-empty
    // bounding rect so we know it's painted, not display:none-d by
    // some surprising container query.
    for (let i = 0; i < 2; i++) {
      const box = await pills.nth(i).boundingBox();
      expect(box, `pill ${i} has no bounding box`).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    }
  });
});

test.describe("Apple Health guidance", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("opens on Integrations and reaches the one-shot import fallback", async ({
    page,
  }) => {
    await page.route("**/api/integrations/healthkit", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            entries: [],
            lastSyncedAt: null,
            syncHealth: { verdict: "pending_first_sync", since: null },
            metricFreshness: [],
          },
          error: null,
        }),
      }),
    );

    await page.goto("/settings/integrations");

    const card = page.getByTestId("apple-health-card");
    await expect(card).toBeVisible();
    // The product name is a proper noun and stays assertable; the sentence
    // around it is not. The description SLOT is the stable target — this spec
    // is about the card rendering its explainer, not about its wording, and
    // the wording is pinned by `apple-health-card.test.tsx` against the same
    // i18n bundle it renders from.
    await expect(card).toContainText("HealthLog iOS app");
    const description = card.locator('[data-slot="settings-card-description"]');
    await expect(description).toBeVisible();
    await expect(description).not.toHaveText("");
    // A raw key means the bundle lookup failed, which is the failure this
    // assertion can actually see from a browser.
    await expect(description).not.toContainText("settings.appleHealth");
    await expect(page.getByTestId("apple-health-status")).toHaveAttribute(
      "data-state",
      "pending-setup",
    );

    const importLink = page.getByTestId("apple-health-import-link");
    await expect(importLink).toHaveAttribute(
      "href",
      "/settings/export#settings-section-import-title",
    );
    await page.goto("/settings/export#settings-section-import-title");
    await expect(page).toHaveURL(
      /\/settings\/export#settings-section-import-title$/,
    );
    await expect(page.getByTestId("import-card-apple-health")).toBeVisible();
  });
});
