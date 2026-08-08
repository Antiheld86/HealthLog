import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

import { CatalogInfo, catalogInfoAvailable } from "../catalog-info";

/**
 * Rung 1 renders the catalogue's own numbers, cited, and nothing personal.
 * The templates compose from `typicalSeriesDoses` / `boosterIntervalMonths` /
 * `category`, so each null combination simply drops its line.
 */
function render(slug: string | null): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <CatalogInfo slug={slug} />
    </I18nProvider>,
  );
}

describe("CatalogInfo rung-1 text", () => {
  it("renders the primary series and a year-interval booster with the source", () => {
    // tetanus: 3 doses, 120-month (10-year) booster, STIKO source.
    const html = render("tetanus");
    expect(html).toContain("Primary series: 3 doses");
    expect(html).toContain("Booster typically every 10 years");
    expect(html).toContain("Source: STIKO Epid Bull 4/2026");
  });

  it("renders a yearly vaccine as yearly, not as an interval", () => {
    // influenza: no primary series, 12-month interval → yearly.
    const html = render("influenza");
    expect(html).toContain("Yearly vaccination");
    expect(html).not.toContain("every 1 year");
    // No primary-series line when the count is null.
    expect(html).not.toContain("Primary series");
  });

  it("renders nothing for a dead slug", () => {
    expect(render("no-such-antigen")).toBe("");
    expect(catalogInfoAvailable("no-such-antigen")).toBe(false);
  });

  it("marks a standard60 entry available", () => {
    // pneumococcal: 1 dose, no interval, standard60.
    expect(catalogInfoAvailable("pneumococcal")).toBe(true);
    const html = render("pneumococcal");
    expect(html).toContain("Standard vaccination from age 60");
  });
});
