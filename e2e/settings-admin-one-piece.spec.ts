import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { settleBeforeMeasure } from "./utils/settle";

/**
 * Settings + Admin read as one surface — measured, not eyeballed.
 *
 * Three claims, each with a number behind it:
 *
 *   1. **No jump on a route switch.** Every settings and admin route puts its
 *      heading at the SAME distance from the top of the scroll container, on
 *      both viewports. This is the U3 complaint stated as a measurement: the
 *      shells hand-rolled the heading, one page used `text-xs sm:text-sm` for
 *      the explainer and another `text-sm`, so the first card started at a
 *      different y depending on where you came from.
 *   2. **One card rhythm.** Inside a settings/admin card, the header's bottom
 *      and the first body block's top sit exactly one gap apart — the card's
 *      own gap, `gap-4` under `md` and `gap-6` above it. Three call-site
 *      techniques used to produce three values here.
 *   3. **One reading edge.** Every card body starts at the card's inner edge.
 *      The `pl-7` gutter put some bodies 28 px in and some at the edge, on the
 *      same page, one card apart.
 *
 * Runs in EN and DE, at desktop and phone widths. German runs 15-25% longer,
 * and an explainer that wraps in German where English fits is the same defect
 * the one-sentence rule exists to prevent — so at desktop width a wrap is a
 * failure in either language. On a phone it is reported, not asserted: a
 * 70-character sentence needs about 380 px of column at `text-sm`, so a
 * 393 px viewport wraps most of them, and the alternative is the truncation
 * this work removed.
 */

test.use({ storageState: STORAGE_STATE_PATH });

const SETTINGS_ROUTES = [
  "/settings",
  "/settings/account",
  "/settings/security",
  "/settings/notifications",
  "/settings/integrations",
  "/settings/ai",
  "/settings/coach",
  "/settings/modules",
  "/settings/layout",
  "/settings/thresholds",
  "/settings/sources",
  "/settings/environment",
  "/settings/export",
  "/settings/gesundheitsakte",
  "/settings/privacy",
  "/settings/api",
  "/settings/mcp",
  "/settings/advanced",
  "/settings/about",
] as const;

const ADMIN_ROUTES = [
  "/admin",
  "/admin/system-status",
  "/admin/general",
  "/admin/services",
  "/admin/users",
  "/admin/invites",
  "/admin/integrations",
  "/admin/coach",
  "/admin/reminders",
  "/admin/backups",
  "/admin/encryption",
  "/admin/app-logs",
  "/admin/api-tokens",
  "/admin/login-overview",
  "/admin/danger-zone",
] as const;

const ROUTES = [...SETTINGS_ROUTES, ...ADMIN_ROUTES];

/**
 * The card's own gap. `SettingsCard` inherits the `<Card>` contract —
 * `gap-4` under `md`, `gap-6` from `md` up — so the expected value is a
 * function of the viewport, not a constant. Asserting a constant here would
 * have hidden exactly the defect this run found: the `as="section"` branch
 * was writing a flat `gap-4` and sat one step tighter than its neighbour on
 * every desktop width.
 */
const cardGapFor = (width: number) => (width >= 768 ? 24 : 16);
/** Sub-pixel and font-metric slack. */
const TOLERANCE = 1.5;

type HeaderGeometry = {
  route: string;
  /** `<h1>` top, relative to the scroll container's content top. */
  headingTop: number;
  /** Height of the whole title + explainer block. */
  headerHeight: number;
  /** Rendered line count of the explainer (1 = it stayed on one line). */
  explainerLines: number;
  explainerText: string;
};

async function measureHeader(
  page: import("@playwright/test").Page,
  route: string,
): Promise<HeaderGeometry | null> {
  return page.evaluate(
    ({ route }) => {
      const main = document.querySelector("main");
      // On a desktop width the visible heading is the real `<h1>`; on a phone
      // the shells paint it above the chip strip as
      // `role="heading" aria-level="1"` and the `<h1>` in the grid row is
      // display:none. Measure whichever one has a box — measuring the hidden
      // copy reports a constant zero and calls it stability.
      const heading = Array.from(
        document.querySelectorAll<HTMLElement>(
          'main h1, main [role="heading"][aria-level="1"]',
        ),
      ).find((el) => el.getBoundingClientRect().height > 0);
      if (!main || !heading) return null;
      const block = heading.parentElement!;
      const explainer = block.querySelector("p");
      const mainTop = main.getBoundingClientRect().top;
      const headBox = heading.getBoundingClientRect();
      const explainerBox = explainer?.getBoundingClientRect();
      const style = explainer ? getComputedStyle(explainer) : null;
      const lineHeight = style ? parseFloat(style.lineHeight) : 0;
      return {
        route,
        headingTop: headBox.top - mainTop,
        // Heading top to explainer bottom. The parent block's own box is not
        // a reliable proxy on a phone, where the heading is rendered outside
        // the grid row it belongs to on desktop.
        headerHeight: (explainerBox?.bottom ?? headBox.bottom) - headBox.top,
        explainerLines:
          lineHeight > 0 && explainerBox
            ? Math.round(explainerBox.height / lineHeight)
            : 0,
        explainerText: explainer?.textContent?.trim() ?? "",
      };
    },
    { route },
  );
}

/**
 * Header-to-body gap and body left edge, per card on the page.
 * Returns one entry per card that has both a header and a following sibling.
 */
async function measureCards(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const out: { gap: number; bodyInset: number }[] = [];
    for (const card of document.querySelectorAll('[data-slot="card"]')) {
      const header = card.querySelector(":scope > header");
      if (!header) continue;
      const next = header.nextElementSibling as HTMLElement | null;
      if (!next) continue;
      if (next.getBoundingClientRect().height === 0) continue;
      const cardBox = card.getBoundingClientRect();
      const cardStyle = getComputedStyle(card);
      const cardInnerLeft = cardBox.left + parseFloat(cardStyle.paddingLeft);
      out.push({
        gap:
          next.getBoundingClientRect().top -
          header.getBoundingClientRect().bottom,
        bodyInset: next.getBoundingClientRect().left - cardInnerLeft,
      });
    }
    return out;
  });
}

for (const locale of ["en", "de"] as const) {
  test.describe(`one piece — ${locale}`, () => {
    test(`page headers land at one height across every route (${locale})`, async ({
      page,
    }) => {
      test.setTimeout(420_000);
      await page.context().addCookies([
        {
          name: "healthlog-locale",
          value: locale,
          url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
        },
      ]);

      const measured: HeaderGeometry[] = [];
      const skipped: string[] = [];
      for (const route of ROUTES) {
        const response = await page.goto(route, {
          waitUntil: "domcontentloaded",
        });
        if (response && response.status() >= 400) continue;
        // A hub route may client-redirect to its first section; wait for the
        // heading and skip a route that legitimately has none rather than
        // failing the sweep on it.
        const heading = page
          .locator(
            'main h1:visible, main [role="heading"][aria-level="1"]:visible',
          )
          .first();
        if (!(await heading.isVisible().catch(() => false))) {
          await heading
            .waitFor({ state: "visible", timeout: 8_000 })
            .catch(() => {});
        }
        if (!(await heading.isVisible().catch(() => false))) {
          skipped.push(route);
          continue;
        }
        await settleBeforeMeasure(page, heading);
        const geometry = await measureHeader(page, route);
        if (geometry) measured.push(geometry);
      }

      console.log(
        `[${locale}] routes without an <h1>: ${skipped.join(", ") || "none"}`,
      );
      // The sweep has to actually look at something.
      expect(measured.length).toBeGreaterThan(25);

      const tops = measured.map((m) => m.headingTop);
      const heights = measured.map((m) => m.headerHeight);
      const spreadTop = Math.max(...tops) - Math.min(...tops);
      const spreadHeight = Math.max(...heights) - Math.min(...heights);

      // Attached so a failure reports WHICH route moved, not just that one did.
      console.log(
        `[${locale}] heading top: ${Math.min(...tops).toFixed(1)}…${Math.max(...tops).toFixed(1)} (spread ${spreadTop.toFixed(1)}px)\n` +
          `[${locale}] header height: ${Math.min(...heights).toFixed(1)}…${Math.max(...heights).toFixed(1)} (spread ${spreadHeight.toFixed(1)}px)\n` +
          measured
            .map(
              (m) =>
                `    ${m.route.padEnd(32)} top ${m.headingTop.toFixed(1)}  h ${m.headerHeight.toFixed(1)}  lines ${m.explainerLines}`,
            )
            .join("\n"),
      );

      // A page explainer that wraps is a text problem, and it is the one the
      // ≤120-character rule exists to prevent. Reported per locale.
      const wrapped = measured.filter((m) => m.explainerLines > 1);
      console.log(
        `[${locale}] explainers wrapping past one line: ${wrapped.length}` +
          wrapped.map((m) => `\n    ${m.route}: ${m.explainerText}`).join(""),
      );
      // The no-jump claim, on every viewport: the title starts at the same y
      // whichever route you came from.
      expect(
        spreadTop,
        "heading top drifts between routes",
      ).toBeLessThanOrEqual(TOLERANCE);

      // The header's HEIGHT can only be constant where every explainer fits on
      // one line, and on a 393 px phone most one-sentence explainers do not —
      // a 70-character sentence at `text-sm` needs about 380 px of column. The
      // honest rule there is that the block grows by whole lines of text, not
      // that it never grows; forcing one height on a phone means truncating,
      // which is the defect this work removed. So the height is pinned at the
      // width where one line is achievable, and on a phone the wrap count is
      // reported rather than asserted.
      const isPhone = (page.viewportSize()?.width ?? 1280) < 768;
      if (!isPhone) {
        expect(
          spreadHeight,
          "header block height drifts between routes",
        ).toBeLessThanOrEqual(TOLERANCE);
        expect(
          wrapped.map((m) => `${m.route}: ${m.explainerText}`),
          "a page explainer wraps to a second line at desktop width",
        ).toEqual([]);
      } else {
        // Every header is one or two lines of the same type scale — never a
        // third, which would mean a subtitle nobody trimmed.
        expect(
          measured.filter((m) => m.explainerLines > 2).map((m) => m.route),
          "a page explainer runs to three lines on a phone",
        ).toEqual([]);
      }
    });

    test(`cards share one header gap and one reading edge (${locale})`, async ({
      page,
    }) => {
      test.setTimeout(420_000);
      await page.context().addCookies([
        {
          name: "healthlog-locale",
          value: locale,
          url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
        },
      ]);

      const gaps: number[] = [];
      const insets: number[] = [];
      const expectedGap = cardGapFor(page.viewportSize()?.width ?? 1280);
      for (const route of ROUTES) {
        const response = await page.goto(route, {
          waitUntil: "domcontentloaded",
        });
        if (response && response.status() >= 400) continue;
        const heading = page
          .locator(
            'main h1:visible, main [role="heading"][aria-level="1"]:visible',
          )
          .first();
        if (!(await heading.isVisible().catch(() => false))) {
          await heading
            .waitFor({ state: "visible", timeout: 8_000 })
            .catch(() => {});
        }
        await settleBeforeMeasure(page, page.locator("main").first());
        for (const card of await measureCards(page)) {
          gaps.push(card.gap);
          insets.push(card.bodyInset);
        }
      }

      expect(gaps.length).toBeGreaterThan(30);

      const offGap = gaps.filter((g) => Math.abs(g - expectedGap) > TOLERANCE);
      const offEdge = insets.filter((i) => Math.abs(i) > TOLERANCE);
      console.log(
        `[${locale}] cards measured: ${gaps.length}; header→body ≠ ${expectedGap}px: ${offGap.length} (${[...new Set(offGap.map((g) => g.toFixed(1)))].join(", ")})\n` +
          `[${locale}] bodies off the card edge: ${offEdge.length} (${[...new Set(offEdge.map((i) => i.toFixed(1)))].join(", ")})`,
      );

      expect(offGap, "header→body gap is not the card's own gap").toEqual([]);
      expect(offEdge, "card body does not start at the card edge").toEqual([]);
    });
  });
}
