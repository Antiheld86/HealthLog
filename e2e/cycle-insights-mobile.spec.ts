import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Pixel-5 mobile smoke for the Insights overview + the cycle vertical
 * (v1.15.10). Mirrors `mobile-viewport.spec.ts`. Asserts:
 *
 *   1. `/insights` has no horizontal page scroll on the Pixel-5 width — the
 *      core guarantee behind the cycle-ring-width fix (the 120 px ring tile
 *      used to overflow narrow grid cells).
 *   2. `/cycle` has no horizontal page scroll on the Pixel-5 width — covers
 *      the tab-strip-overflow fix (the four long German labels used to force
 *      a horizontal scroll at 375 px) and the responsive cycle ring.
 *   3. The cycle-calendar day cells clear the WCAG 2.5.5 mobile tap-target
 *      height floor (44 CSS px) — the `min-h-10` → `min-h-11` bump.
 *
 * The cycle feature gate is enabled by rewriting the real `/api/auth/me`
 * response with `cycleTrackingEnabled: true` (every other field stays
 * authentic), and the `/api/cycle/*` reads are mocked so the wheel, tab strip,
 * and calendar render deterministically without seeding cycle data.
 *
 * Runs only on the `chromium-mobile` project (Pixel 5). The desktop project
 * skips this whole describe block.
 */

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A 90-day-back → 180-day-forward calendar with a recent labelled cycle run
 *  so the wheel resolves a current phase + day and the calendar paints cells. */
function buildCalendarDays(): Array<Record<string, unknown>> {
  const days: Array<Record<string, unknown>> = [];
  const start = new Date();
  start.setDate(start.getDate() - 12);
  // 5 menstrual, 6 follicular, 1 ovulatory, then luteal through today.
  const plan: string[] = [
    ...Array<string>(5).fill("MENSTRUAL"),
    ...Array<string>(6).fill("FOLLICULAR"),
    "OVULATORY",
    "LUTEAL",
    "LUTEAL",
  ];
  for (let i = 0; i < plan.length; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push({
      date: ymd(d),
      phase: plan[i],
      isPredictedPeriod: false,
      isFertileWindow: plan[i] === "OVULATORY",
      isPredictedOvulation: false,
      isPeriodLogged: plan[i] === "MENSTRUAL",
      flow: plan[i] === "MENSTRUAL" ? "MEDIUM" : null,
      hasSymptoms: false,
      confidence: 1,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: null,
    });
  }
  return days;
}

const CALENDAR_BODY = {
  data: {
    profile: {
      goal: "GENERAL_HEALTH",
      rawChartMode: false,
      predictionEnabled: true,
      cyclesObserved: 1,
    },
    prediction: null,
    days: buildCalendarDays(),
    meta: { generatedAt: new Date().toISOString() },
  },
  error: null,
};

const PROFILE_BODY = {
  data: {
    goal: "GENERAL_HEALTH",
    cycleTrackingEnabled: true,
    rawChartMode: false,
    predictionEnabled: true,
    discreetNotifications: false,
    sensitiveCategoryEncryption: false,
    typicalCycleLength: 28,
    typicalPeriodLength: 5,
    lutealPhaseLength: 14,
    updatedAt: new Date().toISOString(),
  },
  error: null,
};

const HISTORY_BODY = {
  data: {
    cycles: [],
    stats: {
      avgLengthDays: null,
      lengthVariabilityDays: null,
      avgPeriodLengthDays: null,
      regularity: "LEARNING",
    },
  },
  error: null,
};

const INSIGHTS_BODY = {
  data: { rows: [], headline: null, symptomPatterns: [] },
  error: null,
};

async function assertNoHorizontalScroll(page: import("@playwright/test").Page) {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    dims.scrollWidth,
    `scrollWidth=${dims.scrollWidth}, innerWidth=${dims.innerWidth}`,
  ).toBeLessThanOrEqual(dims.innerWidth + 1);
}

test.describe("cycle + insights mobile smoke", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");

    // Flip the cycle feature gate ON by rewriting the real /api/auth/me
    // response — every other field stays authentic so the auth shell behaves
    // exactly as in production.
    await page.route("**/api/auth/me", async (route) => {
      const res = await route.fetch();
      const json = await res.json().catch(() => null);
      if (!json?.data) return route.fulfill({ response: res });
      json.data.cycleTrackingEnabled = true;
      return route.fulfill({
        response: res,
        body: JSON.stringify(json),
        headers: { ...res.headers(), "content-type": "application/json" },
      });
    });

    // Deterministic cycle reads.
    await page.route(/\/api\/cycle\/calendar(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(CALENDAR_BODY),
      }),
    );
    await page.route("**/api/cycle/profile", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(PROFILE_BODY),
      }),
    );
    await page.route(/\/api\/cycle\/cycles(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(HISTORY_BODY),
      }),
    );
    await page.route("**/api/cycle/insights", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(INSIGHTS_BODY),
      }),
    );
  });

  test("/insights has no horizontal scroll on Pixel-5", async ({ page }) => {
    await page.goto("/insights", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await assertNoHorizontalScroll(page);
  });

  test("/cycle has no horizontal scroll and the calendar cells clear the 44 px tap floor", async ({
    page,
  }) => {
    await page.goto("/cycle", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // The cycle vertical mounted (the page redirects home if the gate is off).
    const wheel = page.locator('[data-slot="cycle-wheel-tile"]');
    await expect(wheel).toBeVisible();

    // 1) No horizontal page scroll at the Pixel-5 width.
    await assertNoHorizontalScroll(page);

    // 2) Calendar day cells clear the 44 px tap-target height floor.
    const cells = await page.locator('[role="gridcell"]').all();
    const failures: string[] = [];
    for (const cell of cells) {
      if (!(await cell.isVisible().catch(() => false))) continue;
      const box = await cell.boundingBox();
      if (!box) continue;
      if (box.height < 44) {
        const label = (await cell.getAttribute("aria-label")) ?? "(cell)";
        failures.push(`${label.slice(0, 30)} → ${box.height.toFixed(1)}px`);
      }
    }
    expect(
      failures,
      `Calendar cells below 44 px tall:\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
  });
});
