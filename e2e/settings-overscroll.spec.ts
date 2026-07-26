import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { settleBeforeMeasure } from "./utils/settle";

/**
 * Vertical over-scroll regression guard (the recurring class behind the
 * v1.25.11 settings fix): the scroll viewport must never extend far past
 * the last content element. The rule the guard pins is structural — only
 * the AuthShell owns the scroll height and the bottom padding
 * (`pt-6 pb-20` on the wrapper, plus the `<md` bottom-nav clearance on
 * `<main>`); a page/section must never add its own viewport-height
 * reserve or bottom gutter, because every such nested reserve stacks on
 * the shell's own budget and reopens the dark-band-below-the-last-card
 * bug.
 *
 * The assertion: `main.scrollHeight` ≤ bottom edge of the lowest real
 * content element + the shell-owned padding + tolerance. "Real content"
 * is measured against each element's CONTENT-box bottom, not its padding-
 * box: a sub-shell column that re-declares its own bottom gutter (`pb-*`)
 * no longer folds that gutter into `contentBottom`, so a redundant reserve
 * FAILS the assertion instead of being absorbed by it. Runs across both
 * two-column sub-shells — Settings AND Admin (they share the grid-floor
 * source) — at desktop AND phone-shaped viewports, because the two shell
 * paddings differ per breakpoint.
 */
const ROUTES = [
  // Settings sub-shell — short hub, long sortable-list subpages, long form.
  "/settings/layout",
  "/settings/layout/dashboard",
  // The other sortable-list subpages + the Modules hub: each hosts an
  // order editor with the sr-only drag-hint paragraph (see the
  // one-scroll-floor assertion below).
  "/settings/layout/insights",
  "/settings/layout/medications",
  "/settings/layout/mood",
  "/settings/modules",
  "/settings/account",
  "/settings/notifications",
  // Admin sub-shell — short overview + a longer list page. Guards that the
  // pre-#154 column reserve stays retired on every admin breakpoint.
  "/admin",
  "/admin/login-overview",
  "/admin/system-status",
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, expectedPad: 80 }, // wrapper pb-20
  { name: "phone", width: 390, height: 844, expectedPad: 144 }, // pb-20 + main pb-16
] as const;

test.describe("settings + admin vertical over-scroll guard", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "viewport-driven spec; desktop project only",
    );
  });

  for (const vp of VIEWPORTS) {
    for (const route of ROUTES) {
      test(`no over-scroll on ${route} (${vp.name})`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(route, { waitUntil: "domcontentloaded" });
        // Was a fixed 500 ms sleep, which is the wrong shape twice over: too
        // long when the page is ready and too short on a loaded runner, and
        // it never says what it is waiting for. Gate on the element the
        // measurement reads instead.
        await settleBeforeMeasure(page, page.locator("#main-content"));

        const dims = await page.evaluate(() => {
          const main = document.getElementById("main-content");
          if (!main) return null;
          const wrapper = main.firstElementChild as HTMLElement | null;
          if (!wrapper) return null;
          // Lowest content edge: max CONTENT-box bottom over the wrapper's
          // visible, non-fixed descendants, in the scroll container's
          // coordinate space. Using the content box (padding-box bottom
          // minus the element's own bottom padding + border) means a
          // layout column's own `pb-*` gutter is NOT counted — its last
          // real child (a card) is still measured through the column's
          // content box, so a redundant sub-shell bottom gutter shows up
          // as pure over-scroll instead of inflating the allowed budget.
          // Elements inside nested scroll containers are clipped by their
          // own overflow and never add page scroll height, so skip
          // anything whose scrollable ancestor is not `main`.
          let maxBottom = 0;
          const mainTop = main.getBoundingClientRect().top;
          for (const el of wrapper.querySelectorAll<HTMLElement>("*")) {
            const cs = getComputedStyle(el);
            if (cs.position === "fixed") continue;
            const rect = el.getBoundingClientRect();
            if (rect.height === 0 && rect.width === 0) continue;
            // Skip descendants of inner scroll containers (their
            // overflow does not contribute to the page scroll height).
            let p = el.parentElement;
            let inner = false;
            while (p && p !== main) {
              const pcs = getComputedStyle(p);
              if (
                (pcs.overflowY === "auto" || pcs.overflowY === "scroll") &&
                p.scrollHeight > p.clientHeight
              ) {
                inner = true;
                break;
              }
              p = p.parentElement;
            }
            if (inner) continue;
            const padBottom = parseFloat(cs.paddingBottom) || 0;
            const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
            const bottom =
              rect.bottom - padBottom - borderBottom + main.scrollTop - mainTop;
            if (bottom > maxBottom) maxBottom = bottom;
          }
          return {
            scrollHeight: main.scrollHeight,
            clientHeight: main.clientHeight,
            contentBottom: Math.round(maxBottom),
          };
        });

        expect(dims, "main-content / wrapper present").not.toBeNull();
        if (!dims) return;

        // One-scroll-floor (UI-STANDARDS §9): `<main>` is the ONLY vertical
        // scroll surface — the document itself must never become scrollable
        // next to it (a second painted scrollbar + a dead dark band under
        // the shell). The historic offender class: an absolutely-positioned
        // sr-only element (the dnd drag-hint paragraph) whose containing
        // block resolves to the initial containing block because no ancestor
        // between it and the root is positioned — its static position below
        // a long list then extends the DOCUMENT's scrollable overflow while
        // `<main>` clips everything in normal flow.
        const doc = await page.evaluate(() => ({
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight,
        }));
        expect(
          doc.scrollHeight,
          `document scrollHeight=${doc.scrollHeight} > viewport ` +
            `${doc.clientHeight} — a second vertical scroll surface exists ` +
            `beside <main> (likely an absolutely-positioned element escaping ` +
            `to the initial containing block)`,
        ).toBeLessThanOrEqual(doc.clientHeight + 1);

        // A page shorter than the viewport cannot over-scroll at all.
        if (dims.scrollHeight <= dims.clientHeight) return;

        const tolerance = 24;
        expect(
          dims.scrollHeight,
          `scrollHeight=${dims.scrollHeight} contentBottom=${dims.contentBottom} ` +
            `expectedPad=${vp.expectedPad} — the scroll area extends past the ` +
            `last content element + the shell-owned padding; some nested ` +
            `min-h / bottom padding is stacking on the shell budget`,
        ).toBeLessThanOrEqual(dims.contentBottom + vp.expectedPad + tolerance);
      });
    }
  }
});
