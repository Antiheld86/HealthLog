import { expect, type Page } from "@playwright/test";

/**
 * Shared horizontal-overflow guard for phone widths.
 *
 * WHY THIS MEASURES `<main>` AND NOT JUST THE DOCUMENT
 * ----------------------------------------------------
 * The obvious assertion — `documentElement.scrollWidth <= innerWidth` — cannot
 * observe the app's real sideways scroll. `AuthShell` puts every route inside
 *
 *     <main id="main-content" class="… overflow-y-auto …">
 *
 * and CSS says that when one of `overflow-x` / `overflow-y` is not `visible`,
 * the other computes to `auto`. So `<main>` is itself a horizontal scroll
 * container: an over-wide child grows `main.scrollWidth`, the user pans the
 * page sideways, and `documentElement.scrollWidth` never budges because
 * `<main>` absorbed the overflow. A document-only assertion is green through
 * exactly the defect a person reports as "I can scroll sideways off the page".
 *
 * Both measurements are therefore asserted. On failure the helper names the
 * widest element that is actually extending the scroll area (skipping anything
 * an ancestor already scrolls or clips — a strip that is *meant* to pan inside
 * its own `overflow-x-auto` container is not a defect), with its measured
 * width and the viewport width, so a future failure is actionable without a
 * screenshot.
 */

/** Real iPhone + common Android CSS widths. */
export const PHONE_WIDTHS = [360, 390, 393, 402, 430] as const;

export interface OverflowOffender {
  selector: string;
  rectWidth: number;
  rectRight: number;
  scrollWidth: number;
  path: string;
}

export interface OverflowReport {
  innerWidth: number;
  docScrollWidth: number;
  /** null when the route renders outside `AuthShell` (no `<main id>`). */
  mainScrollWidth: number | null;
  mainClientWidth: number | null;
  offenders: OverflowOffender[];
}

/**
 * Measure horizontal overflow of the document AND of the `AuthShell` scroll
 * container, plus the elements responsible.
 */
export async function measureHorizontalOverflow(
  page: Page,
): Promise<OverflowReport> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const de = document.documentElement;
    const main = document.querySelector<HTMLElement>("main#main-content");

    const report = {
      innerWidth: vw,
      docScrollWidth: de.scrollWidth,
      mainScrollWidth: main ? main.scrollWidth : null,
      mainClientWidth: main ? main.clientWidth : null,
      offenders: [] as Array<{
        selector: string;
        rectWidth: number;
        rectRight: number;
        scrollWidth: number;
        path: string;
      }>,
    };

    const overflows =
      de.scrollWidth > vw + 1 ||
      (main !== null && main.scrollWidth > main.clientWidth + 1);
    if (!overflows) return report;

    const describe = (el: Element): string => {
      const parts = [el.tagName.toLowerCase()];
      if (el.id) parts.push(`#${el.id}`);
      const slot = el.getAttribute("data-slot");
      if (slot) parts.push(`[data-slot="${slot}"]`);
      const cls = (el.getAttribute("class") ?? "").trim();
      if (cls) parts.push(`.${cls.split(/\s+/).slice(0, 10).join(".")}`);
      return parts.join("").slice(0, 180);
    };

    const root = main ?? document.body;
    const limit = main
      ? main.getBoundingClientRect().left + main.clientWidth
      : vw;
    const scrollLeft = main ? main.scrollLeft : window.scrollX;

    // An element whose ancestor (below `root`) scrolls or clips is contained by
    // design — the UI standards' "wide content scrolls in its own container".
    const absorbedByAncestor = (el: Element): boolean => {
      let n = el.parentElement;
      while (n && n !== root) {
        const ox = getComputedStyle(n).overflowX;
        if (
          ox === "auto" ||
          ox === "scroll" ||
          ox === "hidden" ||
          ox === "clip"
        )
          return true;
        n = n.parentElement;
      }
      return false;
    };

    for (const el of Array.from(root.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // Fixed/sticky chrome is positioned against the viewport, not the
      // scroll area, so it cannot widen it.
      const position = getComputedStyle(el).position;
      if (position === "fixed" || position === "sticky") continue;
      const right = r.right + scrollLeft;
      if (right <= limit + 1) continue;
      if (absorbedByAncestor(el)) continue;

      const chain: string[] = [];
      let n: Element | null = el;
      while (n && n !== de) {
        chain.unshift(describe(n).slice(0, 70));
        n = n.parentElement;
      }
      report.offenders.push({
        selector: describe(el),
        rectWidth: Math.round(r.width),
        rectRight: Math.round(right),
        scrollWidth: el.scrollWidth,
        path: chain.slice(-5).join(" > "),
      });
    }

    report.offenders.sort((a, b) => b.rectWidth - a.rectWidth);
    report.offenders = report.offenders.slice(0, 5);
    return report;
  });
}

function formatReport(label: string, report: OverflowReport): string {
  const lines = [
    `${label}: horizontal overflow at viewport ${report.innerWidth}px`,
    `  document.scrollWidth = ${report.docScrollWidth} (viewport ${report.innerWidth})`,
    `  main.scrollWidth     = ${report.mainScrollWidth} (client ${report.mainClientWidth})`,
  ];
  if (report.offenders.length === 0) {
    lines.push(
      "  no un-contained offender found — the overflow may come from a scroll container's own content",
    );
  }
  for (const o of report.offenders) {
    lines.push(
      `  • width ${o.rectWidth}px, right edge ${o.rectRight}px — ${o.selector}`,
    );
    lines.push(`      path: ${o.path}`);
  }
  return lines.join("\n");
}

/**
 * Assert the page does not scroll sideways — neither the document nor the
 * `AuthShell` `<main>` scroll container.
 */
export async function expectNoHorizontalOverflow(
  page: Page,
  label: string,
): Promise<void> {
  const report = await measureHorizontalOverflow(page);
  const message = formatReport(label, report);

  expect(report.docScrollWidth, message).toBeLessThanOrEqual(
    report.innerWidth + 1,
  );
  if (report.mainScrollWidth !== null && report.mainClientWidth !== null) {
    expect(report.mainScrollWidth, message).toBeLessThanOrEqual(
      report.mainClientWidth + 1,
    );
  }
}

/**
 * Settle a route before measuring: let the network go idle, pan the whole
 * scroll container so every `next/dynamic` below-the-fold block mounts, then
 * return to the top. A block that only mounts on scroll can only overflow once
 * it has mounted.
 */
export async function settleForOverflowMeasurement(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(async () => {
    const main = document.querySelector<HTMLElement>("main#main-content");
    const el: HTMLElement = main ?? document.documentElement;
    const step = el.clientHeight || 800;
    for (let y = 0; y < el.scrollHeight; y += step) {
      el.scrollTop = y;
      await new Promise((r) => setTimeout(r, 100));
    }
    el.scrollTop = 0;
  });
  await page.waitForLoadState("networkidle").catch(() => {});
}
