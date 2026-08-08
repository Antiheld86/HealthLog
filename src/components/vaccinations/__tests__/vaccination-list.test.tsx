import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { VaccinationDTO } from "@/lib/vaccinations/dto";
import type { SeriesPosition } from "@/lib/vaccinations/series";

import { VaccinationList } from "../vaccination-list";

/**
 * The list answers "what have I had" and "where does each series stand": one
 * group per component antigen, a combined dose rendered once in each of its
 * component groups with that component's own resolved position, and a
 * free-text or dead-slug record folded under its verbatim name. The numbers
 * come from the DTO — this suite never asserts a re-derivation.
 */
function record(
  over: Partial<VaccinationDTO> & { id: string; series: SeriesPosition[] },
): VaccinationDTO {
  return {
    occurredAt: "2020-01-01T00:00:00.000Z",
    antigenSlug: null,
    vaccineName: null,
    doseNumber: null,
    seriesDoses: null,
    lotNumber: null,
    site: null,
    catalogEntry: null,
    practitioner: null,
    encounter: null,
    reminderId: null,
    note: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...over,
  };
}

function render(records: VaccinationDTO[]): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <VaccinationList records={records} />
    </I18nProvider>,
  );
}

describe("VaccinationList grouping", () => {
  it("renders a combination dose in every component group", () => {
    const tdap = record({
      id: "tdap-1",
      antigenSlug: "tdap",
      catalogEntry: { slug: "tdap", atc: "J07AJ52", category: "standard" },
      series: [
        { antigen: "tetanus", position: 3, total: 3, booster: false },
        { antigen: "diphtheria", position: 1, total: 3, booster: false },
        { antigen: "pertussis", position: 1, total: 3, booster: false },
      ],
    });
    const html = render([tdap]);

    for (const antigen of ["tetanus", "diphtheria", "pertussis"]) {
      expect(html).toContain(`data-antigen="${antigen}"`);
    }
    // Three appearances of the one record — one per component group.
    const appearances = html.match(/data-vaccination-id="tdap-1"/g) ?? [];
    expect(appearances).toHaveLength(3);
  });

  it("places a monovalent and a combo in the same antigen group with per-component positions", () => {
    const tetanus = record({
      id: "tet-1",
      antigenSlug: "tetanus",
      catalogEntry: { slug: "tetanus", atc: "J07AM01", category: "standard" },
      occurredAt: "2010-05-05T00:00:00.000Z",
      series: [{ antigen: "tetanus", position: 2, total: 3, booster: false }],
    });
    const tdap = record({
      id: "tdap-2",
      antigenSlug: "tdap",
      catalogEntry: { slug: "tdap", atc: "J07AJ52", category: "standard" },
      series: [
        { antigen: "tetanus", position: 3, total: 3, booster: false },
        { antigen: "pertussis", position: 1, total: 3, booster: false },
      ],
    });
    const html = render([tetanus, tdap]);

    // The tetanus group holds both doses; the pertussis group only the Tdap.
    const tetanusSection = html.slice(html.indexOf('data-antigen="tetanus"'));
    expect(tetanusSection).toContain('data-vaccination-id="tet-1"');
    expect(html).toContain('data-antigen="pertussis"');
    // Dose 3 of 3 renders as resolved text, never recomputed.
    expect(html).toContain("Dose 3 of 3");
  });

  it("renders a booster past the series end as a booster, not a position", () => {
    const html = render([
      record({
        id: "boost-1",
        antigenSlug: "tetanus",
        catalogEntry: { slug: "tetanus", atc: "J07AM01", category: "standard" },
        series: [{ antigen: "tetanus", position: 4, total: 3, booster: true }],
      }),
    ]);
    expect(html).toContain("Booster");
    expect(html).not.toContain("Dose 4 of 3");
  });

  it("folds a free-text and a dead-slug record under their verbatim name", () => {
    const free = record({
      id: "free-1",
      vaccineName: "Some old vaccine",
      series: [],
    });
    const deadSlug = record({
      id: "dead-1",
      antigenSlug: "retired-antigen",
      vaccineName: "Retired brand",
      catalogEntry: null,
      series: [],
    });
    const html = render([free, deadSlug]);

    expect(html).toContain('data-antigen="free"');
    expect(html).toContain("Some old vaccine");
    expect(html).toContain("Retired brand");
    // A free-text row shows no series sentence — nothing is guessed.
    const freeSection = html.slice(html.indexOf('data-vaccination-id="free-1"'));
    expect(freeSection.slice(0, 400)).not.toContain("data-slot=\"vaccination-series\"");
  });
});
