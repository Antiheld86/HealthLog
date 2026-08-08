import { describe, expect, it } from "vitest";

import { parseReferenceRange } from "@/lib/labs/parse-reference-range";

/**
 * Real-shaped strings, taken from the notation German and English lab reports
 * actually print. The parser's contract is asymmetric on purpose: deriving a
 * bound is best-effort, KEEPING the printed string is mandatory. Every case
 * below therefore asserts the verbatim text survives, and only the cases that
 * can be read without guessing assert bounds.
 */
describe("parseReferenceRange — two-sided windows", () => {
  it.each([
    ["3.5-5.0", 3.5, 5],
    ["3,5-5,0", 3.5, 5],
    ["3.5 - 5.0", 3.5, 5],
    ["3,5 – 5,0", 3.5, 5],
    ["3,5 — 5,0", 3.5, 5],
    ["3,5 bis 5,0", 3.5, 5],
    ["3.5 to 5.0", 3.5, 5],
    ["3,5 ... 5,0", 3.5, 5],
    ["3,5 .. 5,0", 3.5, 5],
    ["von 3,5 bis 5,0", 3.5, 5],
    ["[3,5 - 5,0]", 3.5, 5],
    ["(3.5-5.0)", 3.5, 5],
  ])("reads %s as %s..%s", (raw, low, high) => {
    const parsed = parseReferenceRange(raw);
    expect(parsed).toEqual({ low, high, text: raw.trim() });
  });

  it("reads a negative lower bound (base excess prints one)", () => {
    expect(parseReferenceRange("-2,0 bis +3,0")).toEqual({
      low: -2,
      high: 3,
      text: "-2,0 bis +3,0",
    });
  });

  it("reads a German thousands separator as one number, not a decimal", () => {
    // Platelets print as "150.000 - 400.000 /µl" on a German report. Reading
    // the dot as a decimal point would yield a 150–400 window and silently
    // flag every normal count as wildly high.
    expect(parseReferenceRange("150.000 - 400.000")).toEqual({
      low: 150000,
      high: 400000,
      text: "150.000 - 400.000",
    });
  });

  it("reads an English thousands separator", () => {
    expect(parseReferenceRange("150,000 - 400,000")).toEqual({
      low: 150000,
      high: 400000,
      text: "150,000 - 400,000",
    });
  });

  it("refuses a transposed window rather than swapping it", () => {
    // Swapping would be a guess about which digit the lab meant to print.
    expect(parseReferenceRange("5,0 - 3,5")).toEqual({
      low: null,
      high: null,
      text: "5,0 - 3,5",
    });
  });
});

describe("parseReferenceRange — one-sided windows", () => {
  it.each([
    ["< 5", 5],
    ["<5,0", 5],
    ["≤ 5", 5],
    ["<= 5", 5],
    ["bis 5,0", 5],
    ["bis zu 5,0", 5],
    ["max. 5,0", 5],
    ["max 5", 5],
    ["kleiner 5", 5],
    ["unter 5", 5],
    ["up to 5.0", 5],
  ])("reads %s as an upper bound of %s", (raw, high) => {
    expect(parseReferenceRange(raw)).toEqual({
      low: null,
      high,
      text: raw.trim(),
    });
  });

  it.each([
    ["> 3.5", 3.5],
    [">3,5", 3.5],
    ["≥ 3,5", 3.5],
    [">= 3.5", 3.5],
    ["ab 3,5", 3.5],
    ["min. 3,5", 3.5],
    ["mind. 3,5", 3.5],
    ["mindestens 3,5", 3.5],
    ["größer 3,5", 3.5],
    ["groesser 3,5", 3.5],
    ["über 3,5", 3.5],
  ])("reads %s as a lower bound of %s", (raw, low) => {
    expect(parseReferenceRange(raw)).toEqual({
      low,
      high: null,
      text: raw.trim(),
    });
  });
});

describe("parseReferenceRange — units", () => {
  it("reads a window that carries the reading's own unit", () => {
    expect(parseReferenceRange("3,5 - 5,0 mmol/l", "mmol/L")).toEqual({
      low: 3.5,
      high: 5,
      text: "3,5 - 5,0 mmol/l",
    });
  });

  it("reads a trailing unit when the caller states none", () => {
    expect(parseReferenceRange("0,5 - 1,2 mg/dl")).toEqual({
      low: 0.5,
      high: 1.2,
      text: "0,5 - 1,2 mg/dl",
    });
  });

  it("refuses bounds when the printed unit contradicts the reading's unit", () => {
    // Converting mmol/L into mg/dL is interpretation and needs an analyte-
    // specific factor. Keeping the string and no bounds is the honest answer.
    const parsed = parseReferenceRange("3,5 - 5,0 mmol/l", "mg/dL");
    expect(parsed).toEqual({
      low: null,
      high: null,
      text: "3,5 - 5,0 mmol/l",
    });
  });

  it("matches units case- and space-insensitively", () => {
    expect(parseReferenceRange("< 5 MG/DL", "mg/dl")).toEqual({
      low: null,
      high: 5,
      text: "< 5 MG/DL",
    });
  });

  it("tolerates a percent window against a percent reading", () => {
    expect(parseReferenceRange("4,0 - 6,0 %", "%")).toEqual({
      low: 4,
      high: 6,
      text: "4,0 - 6,0 %",
    });
  });
});

describe("parseReferenceRange — text the parser must not invent bounds for", () => {
  it.each([
    "negativ",
    "negative",
    "nicht nachweisbar",
    "siehe Befund",
    "n.n.",
    "unauffällig",
    "altersabhängig",
    "methodenabhängig",
  ])("keeps %s verbatim with no bounds", (raw) => {
    expect(parseReferenceRange(raw)).toEqual({
      low: null,
      high: null,
      text: raw,
    });
  });

  it("keeps a bare number verbatim without treating it as a bound", () => {
    // "5,0" alone states neither a ceiling nor a floor; picking one would be
    // the parser deciding what the report meant.
    expect(parseReferenceRange("5,0")).toEqual({
      low: null,
      high: null,
      text: "5,0",
    });
  });

  it("keeps a three-number string verbatim", () => {
    expect(parseReferenceRange("3,5 - 5,0 - 7,0")).toEqual({
      low: null,
      high: null,
      text: "3,5 - 5,0 - 7,0",
    });
  });

  it("caps an over-long string rather than storing a whole paragraph", () => {
    const parsed = parseReferenceRange("x".repeat(500));
    expect(parsed?.text).toHaveLength(120);
    expect(parsed?.low).toBeNull();
    expect(parsed?.high).toBeNull();
  });

  it("collapses internal whitespace so the stored string stays one line", () => {
    expect(parseReferenceRange("  3,5\n\t-   5,0  ")).toEqual({
      low: 3.5,
      high: 5,
      text: "3,5 - 5,0",
    });
  });
});

describe("parseReferenceRange — absence", () => {
  it.each([null, undefined, "", "   "])("returns null for %s", (raw) => {
    expect(parseReferenceRange(raw)).toBeNull();
  });

  it("refuses a non-finite bound", () => {
    expect(parseReferenceRange("1e999 - 2e999")).toEqual({
      low: null,
      high: null,
      text: "1e999 - 2e999",
    });
  });
});
