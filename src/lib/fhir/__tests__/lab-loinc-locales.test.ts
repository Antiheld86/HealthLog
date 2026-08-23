import { describe, expect, it } from "vitest";

import {
  CATALOG_SLUG_TO_LOINC_KEY,
  localisedLabAliases,
  normaliseLabKey,
  resolveLabCoding,
} from "@/lib/fhir/lab-loinc";
import { locales } from "@/lib/i18n/config";
import { allMessages, resolveKey } from "@/lib/i18n/shared-resolve";
import { BIOMARKER_CATALOG } from "@/lib/labs/biomarker-catalog";

/**
 * A biomarker minted from the labs catalog stores `t("labs.catalog.<slug>")`
 * — the name in the language of whoever minted it — and that stored name is
 * what reaches the FHIR exporter as free text. The alias table it was matched
 * against was written in English and German, so four of the six shipped
 * locales exported every one of these analytes as a text-only concept with no
 * LOINC code.
 */
describe("resolveLabCoding — the analyte name in every shipped locale", () => {
  it.each([
    ["Cholestérol total", "2093-3"],
    ["Colesterol total", "2093-3"],
    ["Colesterolo totale", "2093-3"],
    ["Cholesterol całkowity", "2093-3"],
    ["Créatinine", "2160-0"],
    ["Creatinina", "2160-0"],
    ["Kreatynina", "2160-0"],
    ["Glycémie à jeun", "1558-6"],
    ["Glucosa en ayunas", "1558-6"],
    ["Glicemia a digiuno", "1558-6"],
    ["Glukoza na czczo", "1558-6"],
    ["Ferritine", "2276-4"],
    ["Ferrytyna", "2276-4"],
    ["Hémoglobine", "718-7"],
    ["Emoglobina", "718-7"],
    ["Cholestérol LDL", "18262-6"],
    ["Colesterol HDL", "2085-9"],
    ["Triglycérides", "2571-8"],
    ["Trójglicerydy", "2571-8"],
    ["Insuline à jeun", "27873-9"],
    ["Lipoprotéine(a)", "43583-4"],
  ])("codes %s as LOINC %s", (analyte, loinc) => {
    expect(resolveLabCoding(analyte, "")?.loinc).toBe(loinc);
  });

  it("derives from the bundles rather than from a transcribed list", () => {
    // The property that matters: every locale contributes. A hand-written
    // table would pass the cases above and still be frozen at the languages
    // somebody happened to type.
    for (const locale of locales) {
      const name = resolveKey(
        allMessages[locale],
        "labs.catalog.total-cholesterol",
      );
      expect(name, `${locale} has no catalog name`).toBeTruthy();
      expect(
        resolveLabCoding(name as string, "")?.loinc,
        `${locale}: ${name}`,
      ).toBe("2093-3");
    }
  });

  it("stamps the canonical UCUM when the recorded unit matches", () => {
    expect(resolveLabCoding("Cholestérol total", "mg/dL")).toEqual({
      loinc: "2093-3",
      display: "Cholesterol [Mass/volume] in Serum or Plasma",
      ucum: "mg/dL",
    });
  });

  it("still keeps an unmapped analyte text-only", () => {
    // Conservative by design: a name the app does not ship and no alias names
    // gets no fabricated code, in any language.
    expect(resolveLabCoding("Analyse inconnue", "mg/dL")).toBeNull();
  });
});

describe("resolveLabCoding — the existing English and German behaviour", () => {
  it.each([
    ["HbA1c", "4548-4"],
    ["LDL-C", "18262-6"],
    ["LDL Cholesterol", "18262-6"],
    ["Gesamtcholesterin", "2093-3"],
    ["Kreatinin", "2160-0"],
    ["GPT", "1742-6"],
    ["ASAT", "1920-8"],
    ["hgb", "718-7"],
    ["Nüchternglucose", "1558-6"],
    ["Thyrotropin", "3016-3"],
    ["Apolipoprotein B", "1884-6"],
  ])("still codes %s as LOINC %s", (analyte, loinc) => {
    expect(resolveLabCoding(analyte, "")?.loinc).toBe(loinc);
  });

  it("resolves a German name whose umlaut the old key fold destroyed", () => {
    // "Hämoglobin" used to fold to `hmoglobin`, which matched nothing — the
    // hand-written `hamoglobin` alias only ever caught the un-umlauted typing.
    expect(normaliseLabKey("Hämoglobin")).toBe("hamoglobin");
    expect(resolveLabCoding("Hämoglobin", "g/dL")?.loinc).toBe("718-7");
  });
});

describe("the derived alias index", () => {
  it("contradicts no hand-written alias", () => {
    // A derived name that resolved to a DIFFERENT analyte than a verified
    // alias would be a bundle bug re-pointing an existing mapping. The build
    // refuses it; this asserts the refusal held rather than that it exists.
    for (const [name, key] of Object.entries(localisedLabAliases())) {
      const viaHand = resolveLabCoding(name, "");
      expect(viaHand, name).not.toBeNull();
      expect(viaHand?.loinc, name).toBe(resolveLabCoding(key, "")?.loinc);
    }
  });

  it("is not empty, so a matcher that matches nothing cannot pass", () => {
    expect(Object.keys(localisedLabAliases()).length).toBeGreaterThan(20);
  });

  it("maps only slugs the labs catalog actually ships, in every locale", () => {
    // A renamed slug or a bundle that dropped a name would silently stop
    // deriving: the index would shrink and nothing else would say so.
    const slugs = new Set(BIOMARKER_CATALOG.map((s) => s.slug));
    for (const slug of Object.keys(CATALOG_SLUG_TO_LOINC_KEY)) {
      expect(slugs.has(slug), `catalog lost slug ${slug}`).toBe(true);
      for (const locale of locales) {
        expect(
          resolveKey(allMessages[locale], `labs.catalog.${slug}`),
          `${locale} has no name for ${slug}`,
        ).toBeTruthy();
      }
    }
  });
});
