import { describe, it, expect } from "vitest";

import { locales } from "@/lib/i18n/config";
import {
  buildLocalisedLabelIndex,
  foldLabel,
  labelIn,
  labelsInEveryLocale,
} from "@/lib/i18n/localised-label-index";

describe("foldLabel", () => {
  it("lower-cases and collapses every separator run to one underscore", () => {
    expect(foldLabel("Pantothenic acid (B5)")).toBe("pantothenic_acid_b5");
    expect(foldLabel("waist-to-height ratio")).toBe("waist_to_height_ratio");
    expect(foldLabel("  Grip   strength  ")).toBe("grip_strength");
  });

  it("strips diacritics so an accented word matches its plain spelling", () => {
    expect(foldLabel("Magnésium")).toBe(foldLabel("magnesium"));
    expect(foldLabel("Żelazo")).toBe("zelazo");
    expect(foldLabel("Sélénium")).toBe("selenium");
    expect(foldLabel("Wapń")).toBe("wapn");
  });

  it("folds the stroked letters Unicode decomposition leaves whole", () => {
    // "ż" decomposes to z + a combining dot; "ł" does not decompose at all,
    // so Polish folds only half way without the explicit map.
    expect(foldLabel("Siła chwytu")).toBe("sila_chwytu");
    expect(foldLabel("Masa beztłuszczowa")).toBe("masa_beztluszczowa");
    expect(foldLabel("Größe")).toBe("grosse");
    expect(foldLabel("Grösse")).toBe("grosse");
  });

  it("compatibility-normalises so a subscript agrees with its digit", () => {
    expect(foldLabel("VO₂ max")).toBe("vo2_max");
  });

  it("folds an en-dash range the same as a hyphen one", () => {
    expect(foldLabel("Pain (0–10)")).toBe(foldLabel("pain 0-10"));
  });

  it("folds to the empty string when nothing alphanumeric is left", () => {
    expect(foldLabel("   ")).toBe("");
    expect(foldLabel("—")).toBe("");
  });
});

describe("labelIn / labelsInEveryLocale", () => {
  it("reads a real key out of a named bundle", () => {
    expect(labelIn("fr", "nutrients.names.iron")).toBe("Fer");
    expect(labelIn("pl", "nutrients.names.iron")).toBe("Żelazo");
  });

  it("returns null for a key no bundle carries", () => {
    expect(labelIn("en", "nutrients.names.unobtanium")).toBeNull();
  });

  it("yields one rendering per shipped locale", () => {
    const labels = labelsInEveryLocale("nutrients.names.iron");
    expect(labels).toHaveLength(locales.length);
    expect(labels).toContain("Iron");
    expect(labels).toContain("Fer");
  });

  it("yields nothing at all for an absent key", () => {
    expect(labelsInEveryLocale("nutrients.names.unobtanium")).toEqual([]);
  });
});

describe("buildLocalisedLabelIndex", () => {
  it("indexes a concept under its name in EVERY shipped locale", () => {
    const { index, ambiguous } = buildLocalisedLabelIndex([
      { id: "iron", messageKey: "nutrients.names.iron", value: "iron" },
      { id: "water", messageKey: "nutrients.names.water", value: "water" },
    ]);
    expect(ambiguous.size).toBe(0);
    // One entry per locale — the property that makes a new locale work with
    // no edit here: `locales` is walked, not a hand-typed language list.
    for (const locale of locales) {
      const iron = labelIn(locale, "nutrients.names.iron");
      expect(iron).not.toBeNull();
      expect(index.get(foldLabel(iron!))).toBe("iron");
    }
  });

  it("drops a fold two different concepts claim rather than guessing", () => {
    const { index, ambiguous } = buildLocalisedLabelIndex([
      { id: "a", messageKey: "nutrients.names.iron", value: "a" },
      { id: "b", messageKey: "nutrients.names.iron", value: "b" },
    ]);
    expect(ambiguous).toContain("fer");
    expect(index.get("fer")).toBeUndefined();
  });

  it("treats a repeated id as one concept, not an ambiguity", () => {
    const { index, ambiguous } = buildLocalisedLabelIndex([
      { id: "iron", messageKey: "nutrients.names.iron", value: "iron" },
      { id: "iron", messageKey: "nutrients.names.iron", value: "iron" },
    ]);
    expect(ambiguous.size).toBe(0);
    expect(index.get("fer")).toBe("iron");
  });

  it("degrades to the locales that carry the key instead of failing", () => {
    const { index } = buildLocalisedLabelIndex([
      { id: "x", messageKey: "nutrients.names.unobtanium", value: "x" },
      { id: "iron", messageKey: "nutrients.names.iron", value: "iron" },
    ]);
    expect(index.get("fer")).toBe("iron");
  });
});
