import { describe, expect, it } from "vitest";

import {
  derivedAnalyteNamePattern,
  looksLikeLabDocument,
} from "@/lib/documents/auto-stage-labs";
import { locales } from "@/lib/i18n/config";
import { allMessages, resolveKey } from "@/lib/i18n/shared-resolve";
import { stripDiacritics } from "@/lib/i18n/fold-for-match";

/**
 * The gate decides whether a transcribed document is worth an extraction call.
 * A lab report that fails it is lost from auto-staging entirely, and nothing
 * says so — the manual extract button stays available, so the flow reads as
 * working.
 *
 * Before this, the four signal classes were English and German only, so a
 * report printed anywhere else scored at most one hit (the units, which are
 * the same everywhere) and never reached two.
 */
const FRENCH_REPORT = `
Laboratoire d'analyses médicales
Compte rendu du 14 mars 2026

Cholestérol total     5,8 mmol/l     Valeurs de référence: jusqu'à 5,0
Créatinine            88 µmol/l      Plage de référence: 62 - 106
Hémoglobine           14,2 g/dl
`;

const SPANISH_REPORT = `
Laboratorio de análisis clínicos
Analítica de sangre

Colesterol total      210 mg/dl      Valores de referencia: hasta 200
Glucosa en ayunas     92 mg/dl       Rango de referencia: 70 - 100
`;

const ITALIAN_REPORT = `
Referto di laboratorio — esami del sangue

Colesterolo totale    5,4 mmol/l     Valori di riferimento: fino a 5,0
Emoglobina            13,8 g/dl      Intervallo di riferimento: 12 - 16
`;

const POLISH_REPORT = `
Laboratorium analiz lekarskich
Wyniki badań

Cholesterol całkowity  5,2 mmol/l    Zakres referencyjny: do 5,0
Kreatynina             82 µmol/l     Wartości referencyjne: 62 - 106
`;

describe("looksLikeLabDocument — a report printed outside English and German", () => {
  it.each([
    ["French", FRENCH_REPORT],
    ["Spanish", SPANISH_REPORT],
    ["Italian", ITALIAN_REPORT],
    ["Polish", POLISH_REPORT],
  ])("recognises a %s lab report", (_language, text) => {
    expect(looksLikeLabDocument(text)).toBe(true);
  });

  it("recognises a report on its analyte names and units alone", () => {
    // No header, no reference-range label — the two classes left are the ones
    // a stripped-down result table still carries.
    expect(
      looksLikeLabDocument("Triglycérides 1,4 mmol/l\nFerritine 120 ng/ml"),
    ).toBe(true);
  });
});

/**
 * The four reports above each carry several kinds of evidence at once, so any
 * one of the additions could carry them alone. These cases isolate one
 * addition each: remove the piece each names and the case drops back to a
 * single class and fails the gate.
 */
describe("looksLikeLabDocument — each addition carries its own weight", () => {
  it("needs the DERIVED analyte names for a panel of markers no stem covers", () => {
    // The electrolytes are in the catalog and in no hand-written stem, so the
    // derived names are the only analyte evidence here. Units are the second
    // class.
    expect(
      looksLikeLabDocument("Sodium 140 mmol/l\nPotassium 4,2 mmol/l"),
    ).toBe(true);
    expect(looksLikeLabDocument("Sodio 140 mmol/l\nPotassio 4,2 mmol/l")).toBe(
      true,
    );
  });

  it("needs the reference-range labels of the four locales", () => {
    // "Płytki krwi" is a derived name; the label is the only other class here.
    expect(
      looksLikeLabDocument("Płytki krwi 250\nZakres referencyjny: 150 - 400"),
    ).toBe(true);
    expect(
      looksLikeLabDocument("Plaquettes 250\nValeurs de référence: 150 - 400"),
    ).toBe(true);
  });

  it("needs the report headers of the four locales", () => {
    expect(looksLikeLabDocument("Referto di laboratorio\nPiastrine 250")).toBe(
      true,
    );
    expect(looksLikeLabDocument("Wyniki badań\nPłytki krwi 250")).toBe(true);
    expect(looksLikeLabDocument("Analítica de sangre\nPlaquetas 250")).toBe(
      true,
    );
  });
});

describe("looksLikeLabDocument — what must still fail the gate", () => {
  it.each([
    [
      "English prose with one incidental unit",
      "Please take 500 mg twice daily.",
    ],
    [
      "a French letter mentioning one analyte",
      "Cher patient, votre taux de cholestérol sera revu lors du prochain rendez-vous.",
    ],
    [
      "a Spanish appointment letter",
      "Estimado paciente, su cita en el hospital es el martes a las diez.",
    ],
    [
      "an Italian pharmacy note",
      "Ritirare la confezione in farmacia entro venerdì.",
    ],
    ["an invoice with a currency amount", "Rechnung über 120,00 EUR. Danke."],
  ])("rejects %s", (_case, text) => {
    expect(looksLikeLabDocument(text)).toBe(false);
  });

  it("does not let one analyte named twice reach two classes", () => {
    // The derived names extend the analyte class rather than forming their
    // own. If they were a fifth class, a document saying "Cholestérol total"
    // and "cholesterol" would score two and pass on one piece of evidence.
    expect(looksLikeLabDocument("Cholestérol total et cholesterol")).toBe(
      false,
    );
  });

  it("ignores a derived analyte name embedded in a longer word", () => {
    // The hand-written half of the analyte class matches STEMS on purpose
    // ("ferritin" catches "Ferritinwert"); the derived half is bounded,
    // because a whole catalog name inside another word is noise.
    expect(looksLikeLabDocument("Xhematocritx 5 mg/dl")).toBe(false);
  });
});

describe("looksLikeLabDocument — the English and German behaviour is unchanged", () => {
  it("still recognises a German report", () => {
    expect(
      looksLikeLabDocument(
        "Laborbefund. Hämoglobin 14.2 g/dl. Referenzbereich 13-17. LDL 120 mg/dl.",
      ),
    ).toBe(true);
  });

  it("still recognises an English report", () => {
    expect(
      looksLikeLabDocument(
        "Laboratory report. Hemoglobin 14.2 g/dL. Reference range 13-17.",
      ),
    ).toBe(true);
  });

  it("still rejects the prose the previous guard rejected", () => {
    expect(
      looksLikeLabDocument("Dear patient, please take 500 mg twice daily."),
    ).toBe(false);
  });
});

describe("the derived analyte-name pattern", () => {
  it("carries a name from every shipped locale", () => {
    // The property that matters. A transcribed list would satisfy the report
    // cases above and still be frozen at the languages somebody typed.
    for (const locale of locales) {
      const name = resolveKey(
        allMessages[locale],
        "labs.catalog.total-cholesterol",
      );
      expect(name, `${locale} has no catalog name`).toBeTruthy();
      expect(
        derivedAnalyteNamePattern().test(
          stripDiacritics((name as string).toLowerCase()),
        ),
        `${locale}: ${name}`,
      ).toBe(true);
    }
  });

  it("excludes the short acronyms that are ordinary words elsewhere", () => {
    // "ALT" is German for "old". A three-character alternative in a gate this
    // cheap would make every German letter a lab report. The acronyms worth
    // having live in the hand-written class, each considered on its own.
    const pattern = derivedAnalyteNamePattern();
    for (const acronym of ["alt", "ast", "ggt", "sod"]) {
      expect(pattern.test(acronym), acronym).toBe(false);
    }
  });

  it("is not empty, so a matcher that matches nothing cannot pass", () => {
    expect(derivedAnalyteNamePattern().test("triglycerides")).toBe(true);
    // The Polish "ł" is a single codepoint NFD does not decompose, so it
    // survives the fold on both sides and has to be written as the bundle
    // writes it. A document that spelled it "plytki" would not match, which is
    // the stated limit of folding rather than transliterating.
    expect(derivedAnalyteNamePattern().test("płytki krwi")).toBe(true);
  });
});
