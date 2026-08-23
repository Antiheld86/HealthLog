/**
 * v1.17 — searchable icon picker over the shared curated catalog.
 * The filter is a pure function (name + English keyword aids,
 * case-insensitive, undrawable names excluded) so the search contract
 * is pinned without DOM events; the SSR render covers the radiogroup
 * grid, the selected-tile accent, and the localised search affordances.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  MOOD_TAG_ICON_CATALOG,
  type MoodTagIconCatalogEntry,
} from "@/lib/mood/icon-catalog";
import { isMoodTagIconName } from "../mood-tag-icons";
import { MoodTagIconPicker, filterIconCatalog } from "../mood-tag-icon-picker";

describe("filterIconCatalog", () => {
  it("returns the full drawable catalog for an empty query", () => {
    const all = filterIconCatalog(MOOD_TAG_ICON_CATALOG, "");
    expect(all.length).toBeGreaterThan(40);
    expect(all.every((entry) => isMoodTagIconName(entry.name))).toBe(true);
  });

  it("matches on the icon name, case-insensitive", () => {
    const hits = filterIconCatalog(MOOD_TAG_ICON_CATALOG, "dumbbell");
    expect(hits.map((entry) => entry.name)).toContain("Dumbbell");
  });

  /**
   * The only searchable text used to be the English Lucide name and the
   * English keyword aids, while the grid renders its group headers in the
   * reader's language. A German reader who typed back the header the picker
   * had just shown them got an empty grid and "no icons found" — an empty
   * table with nothing to say the query was fine and the language was not.
   */
  describe("group headers in the reader's language", () => {
    /**
     * The header the picker renders above the health group, per shipped
     * locale, as `mood.manage.iconGroupHealth` spells it. Derived at the call
     * site in the component; pinned here so the property is a test, not a
     * transcription that can drift from the bundle.
     */
    const HEALTH_HEADER: Record<string, string> = {
      en: "Health",
      de: "Gesundheit",
      fr: "Santé",
      es: "Salud",
      it: "Salute",
      pl: "Zdrowie",
    };

    it.each(Object.entries(HEALTH_HEADER))(
      "finds the health icons from the %s header",
      (locale, header) => {
        const labels = { health: header };
        const hits = filterIconCatalog(MOOD_TAG_ICON_CATALOG, header, labels);
        const names = hits.map((entry) => entry.name);
        // Every drawable icon under the header the reader just read. (An
        // English "Health" also hits the "healthy" keyword aid on a food icon,
        // which is a union match and fine — the assertion is on coverage of
        // the group, not on the absence of other hits.)
        for (const entry of MOOD_TAG_ICON_CATALOG) {
          if (entry.group !== "health") continue;
          if (!isMoodTagIconName(entry.name)) continue;
          expect(names).toContain(entry.name);
        }
        void locale;
      },
    );

    it("ignores accents and case in the header match", () => {
      const labels = { weather: "Météo" };
      const hits = filterIconCatalog(MOOD_TAG_ICON_CATALOG, "meteo", labels);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((entry) => entry.group === "weather")).toBe(true);
    });

    it("still finds nothing for a word no header and no keyword carries", () => {
      // The per-icon aids stay English. This is the stated remaining limit,
      // pinned so a later change to it is a deliberate one.
      const labels = { health: "Gesundheit" };
      expect(
        filterIconCatalog(MOOD_TAG_ICON_CATALOG, "herz", labels),
      ).toHaveLength(0);
    });
  });

  it("matches on keyword aids", () => {
    const byKeyword = filterIconCatalog(MOOD_TAG_ICON_CATALOG, "happy");
    expect(byKeyword.length).toBeGreaterThan(0);
    expect(
      byKeyword.some((entry) =>
        entry.keywords.some((k) => k.includes("happy")),
      ) ||
        byKeyword.some((entry) => entry.name.toLowerCase().includes("happy")),
    ).toBe(true);
  });

  it("returns nothing for a miss", () => {
    expect(filterIconCatalog(MOOD_TAG_ICON_CATALOG, "zzzznope")).toEqual([]);
  });

  it("excludes catalog names the client bundle cannot draw", () => {
    const withGhost: MoodTagIconCatalogEntry[] = [
      ...MOOD_TAG_ICON_CATALOG,
      { name: "NotARealIcon", keywords: ["ghost"], group: "misc" },
    ];
    const filtered = filterIconCatalog(withGhost, "");
    expect(filtered.some((entry) => entry.name === "NotARealIcon")).toBe(false);
  });

  it("every shipped catalog entry resolves to a real glyph (allowlist ⊆ client map)", () => {
    for (const entry of MOOD_TAG_ICON_CATALOG) {
      expect(
        isMoodTagIconName(entry.name),
        `unmapped icon: ${entry.name}`,
      ).toBe(true);
    }
  });
});

describe("<MoodTagIconPicker> — SSR", () => {
  function render(value: string | null, locale: "en" | "de" = "en"): string {
    return renderToStaticMarkup(
      <I18nProvider initialLocale={locale}>
        <MoodTagIconPicker value={value} onChange={() => {}} />
      </I18nProvider>,
    );
  }

  it("renders the search input + one radio tile per drawable catalog entry", () => {
    const html = render(null);
    expect(html).toContain('type="search"');
    const tiles = html.match(/data-slot="mood-icon-tile"/g);
    expect(tiles?.length ?? 0).toBe(
      filterIconCatalog(MOOD_TAG_ICON_CATALOG, "").length,
    );
  });

  it("marks the current value with the selected accent + aria-checked", () => {
    const html = render("Heart");
    expect(html).toMatch(
      /data-icon="Heart"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-icon="Heart"/,
    );
  });

  it("resolves the German search placeholder", () => {
    const html = render(null, "de");
    expect(html).toContain("Symbole durchsuchen…");
  });

  it("renders localised group sub-headers", () => {
    const html = render(null, "de");
    expect(html).toContain("Gefühle");
    expect(html).toContain("Aktivitäten");
  });
});
