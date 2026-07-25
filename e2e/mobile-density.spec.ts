import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  LONG_HEADLINE_BRIEFING,
  MOCK_SCORE_RINGS,
  mockDashboardSnapshot,
  POPULATED_SUMMARIES,
} from "./utils/mock-dashboard-snapshot";
import { mockMoodInsights } from "./utils/mock-mood-insights";

/**
 * Phone-width density guard (390×844 iPhone class, 360×780 small
 * Android class).
 *
 * Two invariants, per the original overflow report (long headline text
 * squeezed into a one-word-per-line column beside a wide delta, the
 * delta spilling past the tile edge at 360 px):
 *
 *   1. No horizontal page overflow — `scrollWidth` never exceeds the
 *      viewport width (1 px sub-pixel tolerance).
 *   2. Nothing escapes its tile — for every card / Today hero / list
 *      row, no descendant's visible box crosses the tile's left or
 *      right edge (clip-aware: content genuinely hidden by an inner
 *      `overflow-hidden` wrapper below the tile is fine; content cut
 *      off at the tile's own edge is the bug).
 *
 * The mocks pin the worst case: the Today hero (its score face + a
 * worth-a-look rail) plus a fresh briefing whose rows pair wrapping
 * German headlines with wide delta strings.
 *
 * Desktop project only — the assertions are viewport-driven via
 * `setViewportSize` (the `ipad-viewport.spec.ts` pattern).
 */
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
] as const;

const ROUTES = ["/", "/insights", "/insights/mood"] as const;

interface TileEscape {
  tile: string;
  child: string;
  overRight: number;
  overLeft: number;
  text: string;
}

/** Serialised into the page: measure children escaping their tile. */
function collectTileEscapes(): TileEscape[] {
  const escapes: TileEscape[] = [];
  const tiles = document.querySelectorAll(
    '[data-slot="card"], [data-slot="today-hero"], [data-slot="list-row"]',
  );
  const TOLERANCE = 1;
  for (const tile of tiles) {
    const tileRect = tile.getBoundingClientRect();
    if (tileRect.width === 0) continue;
    for (const child of tile.querySelectorAll("*")) {
      const rect = child.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (getComputedStyle(child).position === "fixed") continue;
      // Clamp by clipping ancestors BELOW the tile only — the tile's
      // own overflow-hidden cutting content off is exactly the bug.
      let left = rect.left;
      let right = rect.right;
      let ancestor = child.parentElement;
      while (ancestor && ancestor !== tile) {
        if (getComputedStyle(ancestor).overflowX !== "visible") {
          const ancestorRect = ancestor.getBoundingClientRect();
          left = Math.max(left, ancestorRect.left);
          right = Math.min(right, ancestorRect.right);
        }
        ancestor = ancestor.parentElement;
      }
      if (right <= left) continue;
      const overRight = right - tileRect.right;
      const overLeft = tileRect.left - left;
      if (overRight > TOLERANCE || overLeft > TOLERANCE) {
        escapes.push({
          tile: tile.getAttribute("data-slot") ?? tile.tagName,
          child:
            child.tagName.toLowerCase() +
            (child.getAttribute("data-slot")
              ? `[${child.getAttribute("data-slot")}]`
              : ""),
          overRight: Math.round(overRight * 10) / 10,
          overLeft: Math.round(overLeft * 10) / 10,
          text: (child.textContent ?? "").trim().slice(0, 60),
        });
      }
    }
  }
  return escapes;
}

test.describe("phone-width density guard", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "viewport-driven spec; desktop project only",
    );
  });

  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      test(`no overflow and no tile escape on ${route} at ${viewport.width}x${viewport.height}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await mockDashboardSnapshot(page, {
          summaries: POPULATED_SUMMARIES,
          briefing: LONG_HEADLINE_BRIEFING,
          scoreRings: MOCK_SCORE_RINGS,
        });
        // The Today hero reads the unified daily digest from
        // `/api/daily/digest`. Mock it with a deterministic digest (a
        // score + one worth-a-look item) so the hero paints without
        // reaching the real route — mirror of the dashboard.spec mock.
        await page.route(/\/api\/daily\/digest(\?|$)/, (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              data: {
                generatedAt: new Date().toISOString(),
                phase: "final",
                sleepPending: false,
                score: { value: 82, band: "green", delta: 2 },
                topSignal: null,
                briefingLead: "Your week is trending steady.",
                line: "Your week is trending steady.",
                worthALook: [
                  {
                    kind: "sync_issue",
                    title: "Sync needs attention",
                    body: "Withings isn't syncing.",
                    status: "warning",
                    actions: [
                      {
                        labelKey: "daily.action.reconnect",
                        intent: "sync.reconnect",
                        href: "/settings/integrations",
                      },
                    ],
                  },
                ],
              },
              error: null,
            }),
          }),
        );
        if (route === "/insights/mood") {
          await mockMoodInsights(page);
        }
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle");

        if (route === "/") {
          // The guard must not pass vacuously — the Today hero and its
          // score face have to actually render.
          await expect(page.locator('[data-slot="today-hero"]')).toBeVisible();
          await expect(
            page.locator('[data-slot="today-hero-score"]'),
          ).toBeVisible();
        }

        if (route === "/insights/mood") {
          // Non-vacuous: the five populated correlation cards and the
          // discovered-relations list — the audit's only user-facing
          // tile-escape cluster — must actually render before the guard
          // sweeps them.
          await expect(
            page.locator('[data-slot="mood-correlation-card"]'),
          ).toHaveCount(5);
          await expect(
            page.locator('[data-slot="mood-discovered-relations"]'),
          ).toBeVisible();
        }

        const dims = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(
          dims.scrollWidth,
          `page scrollWidth=${dims.scrollWidth}, innerWidth=${dims.innerWidth}`,
        ).toBeLessThanOrEqual(dims.innerWidth + 1);
        expect(
          dims.bodyScrollWidth,
          `body scrollWidth=${dims.bodyScrollWidth}`,
        ).toBeLessThanOrEqual(dims.innerWidth + 1);

        const escapes = await page.evaluate(collectTileEscapes);
        expect(
          escapes,
          `tile escapes: ${JSON.stringify(escapes, null, 2)}`,
        ).toEqual([]);
      });
    }
  }
});
