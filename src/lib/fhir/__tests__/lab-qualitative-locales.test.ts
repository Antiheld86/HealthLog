import { describe, expect, it } from "vitest";

import {
  localisedQualitativeIndex,
  qualitativeValueConcept,
} from "@/lib/fhir/lab-qualitative";
import { locales } from "@/lib/i18n/config";
import { allMessages, resolveKey } from "@/lib/i18n/shared-resolve";

const SNOMED = "http://snomed.info/sct";

function codeOf(valueText: string): string | undefined {
  const concept = qualitativeValueConcept(valueText);
  return concept.coding?.[0]?.code;
}

/**
 * The lab form offers "negative" and "positive" as quick picks and writes the
 * LABEL it rendered, so the column holds the bundle's own string in the
 * language the reading was recorded in. Matched against a transcribed
 * English/German list, four of the six shipped locales exported a result the
 * receiving system could not read.
 */
describe("qualitativeValueConcept — the quick-pick label in every locale", () => {
  it.each([
    ["négatif", "260385009"],
    ["negativo", "260385009"],
    ["ujemny", "260385009"],
    ["positif", "10828004"],
    ["positivo", "10828004"],
    ["dodatni", "10828004"],
  ])("codes %s as SNOMED %s", (valueText, code) => {
    expect(codeOf(valueText)).toBe(code);
  });

  it("derives from the bundles rather than from a transcribed list", () => {
    for (const locale of locales) {
      const negative = resolveKey(
        allMessages[locale],
        "labs.form.qualNegative",
      );
      const positive = resolveKey(
        allMessages[locale],
        "labs.form.qualPositive",
      );
      expect(negative, `${locale} has no negative label`).toBeTruthy();
      expect(positive, `${locale} has no positive label`).toBeTruthy();
      expect(codeOf(negative as string), `${locale}: ${negative}`).toBe(
        "260385009",
      );
      expect(codeOf(positive as string), `${locale}: ${positive}`).toBe(
        "10828004",
      );
    }
  });

  it("tolerates a term typed without its accents", () => {
    expect(codeOf("Negatif")).toBe("260385009");
    expect(codeOf("NÉGATIF")).toBe("260385009");
  });

  it("keeps the raw text on the concept whatever the language", () => {
    expect(qualitativeValueConcept("négatif")).toEqual({
      coding: [{ system: SNOMED, code: "260385009", display: "Negative" }],
      text: "négatif",
    });
  });
});

describe("qualitativeValueConcept — what stays text-only, and why", () => {
  it("leaves borderline uncoded in every locale", () => {
    // The candidate "Borderline" qualifier concept was never confidently
    // verified, so `labs.form.qualBorderline` is read by nothing. This pins
    // that the derivation did not sweep it up by accident.
    for (const locale of locales) {
      const label = resolveKey(allMessages[locale], "labs.form.qualBorderline");
      expect(label, `${locale} has no borderline label`).toBeTruthy();
      expect(
        qualitativeValueConcept(label as string).coding,
        `${locale}: ${label}`,
      ).toBeUndefined();
    }
  });

  it("leaves the detected / not-detected pair uncoded outside English and German", () => {
    // The honest limit of this change, written down rather than discovered
    // later: the app ships no string for these, they are prose a lab printed,
    // and inventing the four other languages would be inventing clinical
    // vocabulary nobody here can check.
    expect(codeOf("nicht nachweisbar")).toBe("260415000");
    expect(codeOf("not detected")).toBe("260415000");
    expect(codeOf("non détecté")).toBeUndefined();
    expect(codeOf("niewykrywalny")).toBeUndefined();
    expect(qualitativeValueConcept("non détecté")).toEqual({
      text: "non détecté",
    });
  });

  it("leaves free prose uncoded", () => {
    expect(qualitativeValueConcept("siehe Befund")).toEqual({
      text: "siehe Befund",
    });
  });
});

describe("qualitativeValueConcept — the existing English and German terms", () => {
  it.each([
    ["negativ", "260385009"],
    ["negative", "260385009"],
    ["Negativ", "260385009"],
    ["neg", "260385009"],
    ["positiv", "10828004"],
    ["positive", "10828004"],
    ["pos", "10828004"],
    ["nachweisbar", "260373001"],
    ["detected", "260373001"],
  ])("still codes %s as SNOMED %s", (valueText, code) => {
    expect(codeOf(valueText)).toBe(code);
  });
});

describe("the derived qualitative index", () => {
  it("is not empty, so a matcher that matches nothing cannot pass", () => {
    expect(Object.keys(localisedQualitativeIndex()).length).toBeGreaterThan(3);
  });

  it("never puts one word on both arms", () => {
    // Two locales spelling a term the same way ("negativo" in Spanish and
    // Italian) is expected and folds onto one row. The same word meaning both
    // negative and positive would be a bundle bug.
    const negatives = new Set<string>();
    const positives = new Set<string>();
    for (const [word, concept] of Object.entries(localisedQualitativeIndex())) {
      (concept.code === "260385009" ? negatives : positives).add(word);
    }
    for (const word of negatives) expect(positives.has(word)).toBe(false);
  });
});
