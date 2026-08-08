import { describe, expect, it } from "vitest";

import {
  classifyAgainstEffectiveRange,
  resolveEffectiveReferenceRange,
} from "@/lib/labs/reference-range";

const NO_SOURCE = {
  sourceReferenceLow: null,
  sourceReferenceHigh: null,
  sourceReferenceText: null,
};

describe("resolveEffectiveReferenceRange", () => {
  it("falls back to the catalog band when the reading carries no source window", () => {
    const eff = resolveEffectiveReferenceRange(3.5, 5, NO_SOURCE);
    expect(eff).toMatchObject({
      low: 3.5,
      high: 5,
      origin: "catalog",
      catalogLow: 3.5,
      catalogHigh: 5,
      sourceText: null,
      divergesFromCatalog: false,
    });
  });

  it("reports no window when neither side states one", () => {
    expect(resolveEffectiveReferenceRange(null, null, NO_SOURCE)).toMatchObject(
      { low: null, high: null, origin: "none", divergesFromCatalog: false },
    );
  });

  it("lets the source window win over the catalog band for that reading", () => {
    const eff = resolveEffectiveReferenceRange(3.5, 5, {
      sourceReferenceLow: 3.9,
      sourceReferenceHigh: 5.4,
      sourceReferenceText: "3,9 - 5,4",
    });
    expect(eff).toMatchObject({
      low: 3.9,
      high: 5.4,
      origin: "source",
      catalogLow: 3.5,
      catalogHigh: 5,
      sourceText: "3,9 - 5,4",
      divergesFromCatalog: true,
    });
  });

  it("does not call an identical window a divergence", () => {
    const eff = resolveEffectiveReferenceRange(3.5, 5, {
      sourceReferenceLow: 3.5,
      sourceReferenceHigh: 5,
      sourceReferenceText: "3,5 - 5,0",
    });
    expect(eff.origin).toBe("source");
    expect(eff.divergesFromCatalog).toBe(false);
  });

  it("takes a one-sided source window whole, not merged with the catalog", () => {
    // A report that prints "< 5" states a ceiling and NO floor. Borrowing the
    // catalog's floor would invent a window the report never stated.
    const eff = resolveEffectiveReferenceRange(3.5, 5, {
      sourceReferenceLow: null,
      sourceReferenceHigh: 4.2,
      sourceReferenceText: "< 4,2",
    });
    expect(eff).toMatchObject({
      low: null,
      high: 4.2,
      origin: "source",
      divergesFromCatalog: true,
    });
  });

  it("does not displace the catalog for a printed window with no derivable bound", () => {
    // "negativ" is carried through verbatim, but it is not an argument for
    // discarding the catalog band.
    const eff = resolveEffectiveReferenceRange(3.5, 5, {
      sourceReferenceLow: null,
      sourceReferenceHigh: null,
      sourceReferenceText: "negativ",
    });
    expect(eff).toMatchObject({
      low: 3.5,
      high: 5,
      origin: "catalog",
      sourceText: "negativ",
      divergesFromCatalog: false,
    });
  });

  it("reports a source window as no divergence when the catalog has none", () => {
    const eff = resolveEffectiveReferenceRange(null, null, {
      sourceReferenceLow: 3.9,
      sourceReferenceHigh: 5.4,
      sourceReferenceText: "3,9 - 5,4",
    });
    expect(eff.origin).toBe("source");
    expect(eff.divergesFromCatalog).toBe(false);
  });
});

describe("classifyAgainstEffectiveRange", () => {
  it("judges a reading by the source window, not the catalog band", () => {
    // 5.2 sits inside the catalog band (3.5–5.0 would call it high) but the
    // report that produced this value states 3.9–5.4, so it is in range.
    const eff = resolveEffectiveReferenceRange(3.5, 5, {
      sourceReferenceLow: 3.9,
      sourceReferenceHigh: 5.4,
      sourceReferenceText: "3,9 - 5,4",
    });
    expect(classifyAgainstEffectiveRange(5.2, eff)).toBe("in-range");
    expect(classifyAgainstEffectiveRange(3.7, eff)).toBe("below");
    expect(classifyAgainstEffectiveRange(5.5, eff)).toBe("above");
  });

  it("keeps the catalog verdict for a reading with no source window", () => {
    const eff = resolveEffectiveReferenceRange(3.5, 5, NO_SOURCE);
    expect(classifyAgainstEffectiveRange(5.2, eff)).toBe("above");
  });

  it("never classifies a qualitative reading", () => {
    const eff = resolveEffectiveReferenceRange(3.5, 5, NO_SOURCE);
    expect(classifyAgainstEffectiveRange(null, eff)).toBe("unknown");
  });
});
