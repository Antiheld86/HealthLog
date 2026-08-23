import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";
import {
  isUnreadableRange,
  parseReferenceRange,
  RANGE_PROSE,
} from "@/lib/labs/parse-reference-range";

/**
 * The notation a lab prints is the LAB's prose, not the app's, so this parser
 * cannot derive its vocabulary from `messages/<locale>.json` the way a matcher
 * over app-owned labels does. The table is hand-written, and these are the
 * strings it has to read: real reference-range notation as French, Spanish,
 * Italian and Polish reports print it, decimal comma included.
 *
 * Before the table existed, every case below returned `low: null, high: null`
 * — the string was stored and the reading was then judged against a band the
 * lab never printed, or against no band at all, with nothing anywhere saying
 * so.
 */
describe("parseReferenceRange — French notation", () => {
  it.each([
    ["jusqu'à 5,0", null, 5],
    ["jusqu’à 5,0", null, 5],
    ["JUSQU'À 5,0", null, 5],
    ["inférieur à 5,0", null, 5],
    ["moins de 5,0", null, 5],
    ["à partir de 3,5", 3.5, null],
    ["supérieur à 3,5", 3.5, null],
    ["au moins 3,5", 3.5, null],
    ["3,5 à 5,0", 3.5, 5],
    ["de 3,5 à 5,0", 3.5, 5],
    ["entre 3,5 et 5,0", 3.5, 5],
    ["valeurs de référence 3,5 - 5,0", 3.5, 5],
  ])("reads %s as %s..%s", (raw, low, high) => {
    expect(parseReferenceRange(raw)).toEqual({ low, high, text: raw });
  });
});

describe("parseReferenceRange — Spanish notation", () => {
  it.each([
    ["hasta 5,0", null, 5],
    ["menor de 5,0", null, 5],
    ["inferior a 5,0", null, 5],
    ["como máximo 5,0", null, 5],
    ["desde 3,5", 3.5, null],
    ["mayor que 3,5", 3.5, null],
    ["superior a 3,5", 3.5, null],
    ["más de 3,5", 3.5, null],
    ["3,5 a 5,0", 3.5, 5],
    ["de 3,5 a 5,0", 3.5, 5],
    ["entre 3,5 y 5,0", 3.5, 5],
    ["valores de referencia 3,5 - 5,0", 3.5, 5],
  ])("reads %s as %s..%s", (raw, low, high) => {
    expect(parseReferenceRange(raw)).toEqual({ low, high, text: raw });
  });
});

describe("parseReferenceRange — Italian notation", () => {
  it.each([
    ["fino a 5,0", null, 5],
    ["inferiore a 5,0", null, 5],
    ["meno di 5,0", null, 5],
    ["oltre 3,5", 3.5, null],
    ["superiore a 3,5", 3.5, null],
    ["più di 3,5", 3.5, null],
    ["almeno 3,5", 3.5, null],
    ["3,5 a 5,0", 3.5, 5],
    ["da 3,5 a 5,0", 3.5, 5],
    ["tra 3,5 e 5,0", 3.5, 5],
    ["valori di riferimento 3,5 - 5,0", 3.5, 5],
  ])("reads %s as %s..%s", (raw, low, high) => {
    expect(parseReferenceRange(raw)).toEqual({ low, high, text: raw });
  });

  it("reads a bare Italian floor rather than swallowing its introducing word", () => {
    // "da" both introduces a two-sided window ("da 3,5 a 5,0") and states a
    // floor on its own. Stripping introducing words before matching — which is
    // what the parser used to do unconditionally — turns the second form into
    // a bare number with no bound at all.
    expect(parseReferenceRange("da 3,5")).toEqual({
      low: 3.5,
      high: null,
      text: "da 3,5",
    });
  });
});

describe("parseReferenceRange — Polish notation", () => {
  it.each([
    ["do 5,0", null, 5],
    ["poniżej 5,0", null, 5],
    ["mniej niż 5,0", null, 5],
    ["maks. 5,0", null, 5],
    ["od 3,5", 3.5, null],
    ["powyżej 3,5", 3.5, null],
    ["co najmniej 3,5", 3.5, null],
    ["3,5 do 5,0", 3.5, 5],
    ["od 3,5 do 5,0", 3.5, 5],
    ["zakres referencyjny 3,5 - 5,0", 3.5, 5],
  ])("reads %s as %s..%s", (raw, low, high) => {
    expect(parseReferenceRange(raw)).toEqual({ low, high, text: raw });
  });
});

describe("parseReferenceRange — the new prose does not loosen the old rules", () => {
  it("still refuses a bare number in any language", () => {
    expect(parseReferenceRange("5,0")).toEqual({
      low: null,
      high: null,
      text: "5,0",
    });
  });

  it("does not read scientific notation as a two-sided window", () => {
    // "e" is an Italian separator ("tra 3,5 e 5,0") and "y" a Spanish one.
    // Both are one letter, so they are only accepted with whitespace on both
    // sides — otherwise "3.5e5" would parse as a 3.5–5 window.
    expect(parseReferenceRange("3.5e5")).toEqual({
      low: null,
      high: null,
      text: "3.5e5",
    });
  });

  it("still refuses a transposed window printed in French", () => {
    expect(parseReferenceRange("de 5,0 à 3,5")).toEqual({
      low: null,
      high: null,
      text: "de 5,0 à 3,5",
    });
  });

  it("still refuses bounds when the printed unit contradicts the reading", () => {
    expect(parseReferenceRange("jusqu'à 5,0 mmol/l", "mg/dL")).toEqual({
      low: null,
      high: null,
      text: "jusqu'à 5,0 mmol/l",
    });
  });
});

describe("parseReferenceRange — an unreadable window is named, not silent", () => {
  it("separates 'nothing printed' from 'printed and not read'", () => {
    expect(parseReferenceRange(null)).toBeNull();
    expect(isUnreadableRange(parseReferenceRange(null))).toBe(false);

    const prose = parseReferenceRange("voir le compte rendu");
    expect(prose).toEqual({
      low: null,
      high: null,
      text: "voir le compte rendu",
    });
    expect(isUnreadableRange(prose)).toBe(true);
  });

  it("reports a window it DID read as readable", () => {
    expect(isUnreadableRange(parseReferenceRange("jusqu'à 5,0"))).toBe(false);
  });
});

describe("RANGE_PROSE coverage", () => {
  it("carries an entry for every shipped locale", () => {
    // Keyed by the `Locale` union on purpose: a seventh locale cannot be added
    // to `locales` without someone answering how that language prints a range.
    // This asserts the runtime side of the same promise.
    expect(Object.keys(RANGE_PROSE).sort()).toEqual([...locales].sort());
  });

  it("states at least one word for each notation in each locale", () => {
    for (const locale of locales) {
      const prose = RANGE_PROSE[locale];
      expect(prose.twoSided.length, `${locale}.twoSided`).toBeGreaterThan(0);
      expect(prose.upper.length, `${locale}.upper`).toBeGreaterThan(0);
      expect(prose.lower.length, `${locale}.lower`).toBeGreaterThan(0);
    }
  });

  it("carries the table already folded, so both sides of a match agree", () => {
    // A row written with an accent would never match: the input is
    // diacritic-folded before it reaches the alternation, so an accented row
    // is a row that can only ever miss.
    for (const locale of locales) {
      const prose = RANGE_PROSE[locale];
      for (const word of [
        ...prose.twoSided,
        ...prose.upper,
        ...prose.lower,
        ...prose.filler,
      ]) {
        expect(word.normalize("NFD"), `${locale}: ${word}`).not.toMatch(/[̀-ͯ]/u);
        expect(word, `${locale}: ${word}`).toBe(word.toLowerCase());
      }
    }
  });
});
