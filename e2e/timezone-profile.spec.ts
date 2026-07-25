import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Issue #490 — client-rendered timestamps follow the PROFILE timezone.
 *
 * `/api/auth/me` is mocked with an `Asia/Manila` profile; the sessions
 * card on /settings/privacy renders `lastActiveAt` through
 * `useFormatters()`, which reads the localStorage timezone mirror that
 * `fetchMe` fills from the mocked payload. A fixed UTC instant must
 * therefore paint the MANILA wall clock (14:30), never the Berlin
 * fallback (08:30) and never the browser zone (the Playwright context is
 * pinned to Europe/Berlin precisely so this assertion is meaningful).
 *
 * Asserts against the stable `data-slot="security-session-row"` hook,
 * not viewport-dependent text.
 */

// 06:30 UTC = 14:30 Asia/Manila (+8, no DST) = 08:30 Europe/Berlin (CEST).
const LAST_ACTIVE_UTC = "2026-07-14T06:30:00.000Z";

test.describe("profile-timezone display (#490)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("sessions card renders lastActiveAt in the Manila profile zone", async ({
    page,
  }) => {
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "user_e2e",
            username: "e2e-tester",
            email: "e2e@healthlog.test",
            role: "USER",
            heightCm: 180,
            dateOfBirth: "1990-01-01",
            gender: "MALE",
            timezone: "Asia/Manila",
            timeFormat: "H24",
            dateFormat: "AUTO",
            onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
            onboardingTourCompleted: true,
            gravatarUrl: null,
            glucoseUnit: "mg/dL",
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/auth/me/sessions", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            sessions: [
              {
                id: "sess_e2e_current",
                device: "Chrome on macOS",
                ipMasked: "192.168.1.xxx",
                location: null,
                lastActiveAt: LAST_ACTIVE_UTC,
                createdAt: LAST_ACTIVE_UTC,
                isCurrent: true,
              },
            ],
          },
          error: null,
        }),
      }),
    );

    await page.goto("/settings/privacy", { waitUntil: "domcontentloaded" });

    // The sessions card is collapsed by default — expand it first. The
    // toggle's onClick can be dropped if Playwright clicks before React has
    // hydrated the handler, leaving the region `hidden` for the whole wait.
    // Retry the click until `aria-expanded` actually flips.
    const toggle = page.locator(
      '[data-slot="settings-security-sessions-toggle"]',
    );
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await expect(async () => {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true", {
        timeout: 2_000,
      });
    }).toPass({ timeout: 15_000 });

    const row = page.locator('[data-slot="security-session-row"]').first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Manila wall clock (H24). The mirror write from the mocked /me may
    // land after the first paint of the sessions row — the poll absorbs
    // the re-render.
    await expect(row).toContainText("14:30", { timeout: 10_000 });
    // Never the Berlin fallback for this instant…
    await expect(row).not.toContainText("08:30");
    // …and never a 12-hour rendering (the H24 preference rides the same
    // mirror pipeline).
    await expect(row).not.toContainText("PM");
  });
});
