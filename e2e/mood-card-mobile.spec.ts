import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.15 phase-A3 fix #2 — mood-list mobile card was rendering the score
 * twice: once in the left badge (large bold digit) and once in the title
 * line as "{score} ({label})". On desktop the table view only ever showed
 * one. The fix collapses the title line down to just the localized label
 * (e.g., "Schlecht"), so the row reads
 *
 *     [ 2 ]  Schlecht
 *            12.05.2026, 18:30
 *
 * The Pixel-5 viewport is the only one that mounted the mobile branch
 * (`md:hidden`) so the regression was mobile-only — this spec runs on the
 * `chromium-mobile` project and asserts each `data-testid="mood-row"`
 * contains exactly one occurrence of its score digit.
 */
test.describe("mood card mobile layout", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("each mobile row shows the score number exactly once", async ({
    page,
  }) => {
    // Stub the mood-entries endpoint with a deterministic dataset whose
    // scores are all distinct digits — that lets us reason about
    // "exactly one occurrence" per row independently of locale or label.
    await page.route("**/api/mood-entries*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            entries: [
              {
                id: "m1",
                date: "2026-05-08",
                mood: "SCHLECHT",
                score: 2,
                tags: [],
                source: "MANUAL",
                moodLoggedAt: "2026-05-08T08:30:00.000Z",
              },
              {
                id: "m2",
                date: "2026-05-07",
                mood: "GUT",
                score: 4,
                tags: [],
                source: "MANUAL",
                moodLoggedAt: "2026-05-07T19:00:00.000Z",
              },
            ],
            meta: { total: 2 },
          },
          error: null,
        }),
      }),
    );

    await page.goto("/mood", { waitUntil: "domcontentloaded" });

    const rows = page.locator('[data-testid="mood-row"]');
    await expect(rows).toHaveCount(2, { timeout: 10_000 });

    // For each row, the rendered text must contain its score digit
    // exactly once. The desktop table also shows the digit + label in
    // one cell, but `md:hidden` hides this branch above the breakpoint —
    // on the Pixel-5 profile only the mobile branch mounts.
    for (let i = 0; i < 2; i++) {
      const row = rows.nth(i);
      const text = await row.innerText();
      const expectedScore = i === 0 ? "2" : "4";
      const occurrences = (
        text.match(new RegExp(`(?<!\\d)${expectedScore}(?!\\d)`, "g")) ?? []
      ).length;
      expect(
        occurrences,
        `row ${i} should contain "${expectedScore}" exactly once, got ${occurrences} in: ${text}`,
      ).toBe(1);
    }

    // The big-badge score must still be present (we kept it).
    const scoreBadges = page.locator('[data-testid="mood-row-score"]');
    await expect(scoreBadges).toHaveCount(2);
    await expect(scoreBadges.nth(0)).toHaveText("2");
    await expect(scoreBadges.nth(1)).toHaveText("4");
  });
});
