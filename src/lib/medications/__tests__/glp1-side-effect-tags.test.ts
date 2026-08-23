/**
 * The GLP-1 side-effect tag catalogue, and the property the three readers
 * used to get wrong: a tag recorded in ANY shipped locale resolves to the same
 * key, so it contributes exactly as much as the English one.
 *
 * Before this module the readers matched the stored LABEL against a
 * hand-written English/German word list. A French, Spanish, Italian or Polish
 * account tapping the same chip contributed nothing to the timeline, the Coach
 * snapshot or the doctor report, and nothing said so.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";
import { resolveKey } from "@/lib/i18n/resolve-key";
import {
  GLP1_SIDE_EFFECT_TAGS,
  GLP1_SIDE_EFFECT_TAG_KEYS,
  GLP1_SIDE_EFFECT_TAG_LABEL_KEYS,
  normaliseSideEffectTag,
  parseMoodTagList,
} from "../glp1-side-effect-tags";
import {
  glp1SideEffectTagIndex,
  matchGlp1SideEffectTags,
  resolveGlp1SideEffectTag,
} from "../glp1-side-effect-tag-match";

const ROOT = join(__dirname, "../../../..");

function bundle(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(ROOT, `messages/${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

describe("GLP-1 side-effect tag catalogue", () => {
  it("resolves the chip label of every shipped locale to the same key", () => {
    for (const { key, labelKey } of GLP1_SIDE_EFFECT_TAGS) {
      for (const locale of locales) {
        const label = resolveKey(bundle(locale), labelKey);
        expect(
          label,
          `${labelKey} missing from messages/${locale}.json`,
        ).toBeTruthy();
        expect(
          resolveGlp1SideEffectTag(label as string),
          `${locale} label "${label}" must resolve to ${key}`,
        ).toBe(key);
      }
    }
  });

  it("counts a French-labelled tag exactly as an English one", () => {
    // The reported defect, stated as an equality rather than a spot check.
    for (const { key, labelKey } of GLP1_SIDE_EFFECT_TAGS) {
      const en = resolveKey(bundle("en"), labelKey) as string;
      const fr = resolveKey(bundle("fr"), labelKey) as string;
      expect(matchGlp1SideEffectTags(JSON.stringify([fr]))).toEqual(
        matchGlp1SideEffectTags(JSON.stringify([en])),
      );
      expect(matchGlp1SideEffectTags(JSON.stringify([fr])).matched).toEqual([
        key,
      ]);
    }
  });

  it("resolves the Spanish, Italian and Polish chip labels", () => {
    // Named explicitly so a regression reads as "Polish stopped working"
    // rather than as an anonymous loop failure.
    expect(resolveGlp1SideEffectTag("Náuseas")).toBe("nausea");
    expect(resolveGlp1SideEffectTag("Pérdida de apetito")).toBe(
      "appetite-loss",
    );
    expect(resolveGlp1SideEffectTag("Bruciore di stomaco")).toBe("heartburn");
    expect(resolveGlp1SideEffectTag("Stitichezza")).toBe("constipation");
    expect(resolveGlp1SideEffectTag("Nudności")).toBe("nausea");
    expect(resolveGlp1SideEffectTag("Ból głowy")).toBe("headache");
    expect(resolveGlp1SideEffectTag("Zmęczenie")).toBe("fatigue");
  });

  it("keeps matching the English and German tags already in the database", () => {
    // The pre-fix word list is the historical write vocabulary; every string
    // on it must survive the swap or existing records lose their history.
    for (const legacy of [
      "nausea",
      "constipation",
      "diarrhea",
      "fatigue",
      "appetite-loss",
      "heartburn",
      "headache",
      "übelkeit",
      "verstopfung",
      "durchfall",
      "müdigkeit",
      "appetitlosigkeit",
      "sodbrennen",
      "kopfschmerzen",
    ]) {
      expect(
        resolveGlp1SideEffectTag(legacy),
        `legacy tag "${legacy}" must still resolve`,
      ).not.toBeNull();
    }
  });

  it("tolerates case, accents and separator drift", () => {
    expect(resolveGlp1SideEffectTag("  NAUSEA ")).toBe("nausea");
    expect(resolveGlp1SideEffectTag("ubelkeit")).toBe("nausea");
    expect(resolveGlp1SideEffectTag("appetite loss")).toBe("appetite-loss");
    // The French bundle uses a typographic apostrophe; a keyboard produces a
    // straight one.
    expect(resolveGlp1SideEffectTag("Perte d'appétit")).toBe("appetite-loss");
    expect(resolveGlp1SideEffectTag("Perte d’appétit")).toBe("appetite-loss");
  });

  it("refuses free text rather than inventing a side effect", () => {
    for (const free of ["gym", "date night", "Arbeit", "", "   "]) {
      expect(resolveGlp1SideEffectTag(free)).toBeNull();
    }
  });

  it("counts what it could not classify instead of dropping it silently", () => {
    const match = matchGlp1SideEffectTags(
      JSON.stringify(["Nudności", "siłownia", "rodzina"]),
    );
    expect(match.matched).toEqual(["nausea"]);
    expect(match.unresolvedCount).toBe(2);
  });

  it("deduplicates a key reached through two different spellings", () => {
    const match = matchGlp1SideEffectTags(
      JSON.stringify(["nausea", "Übelkeit", "Náuseas"]),
    );
    expect(match.matched).toEqual(["nausea"]);
    expect(match.unresolvedCount).toBe(0);
  });

  it("reads both stored column shapes", () => {
    expect(parseMoodTagList('["nausea","gym"]')).toEqual(["nausea", "gym"]);
    expect(parseMoodTagList("nausea, gym")).toEqual(["nausea", "gym"]);
    expect(parseMoodTagList(null)).toEqual([]);
    expect(matchGlp1SideEffectTags("Übelkeit, Sport").matched).toEqual([
      "nausea",
    ]);
  });

  it("maps every key to a label key that resolves in all six locales", () => {
    for (const key of GLP1_SIDE_EFFECT_TAG_KEYS) {
      const labelKey = GLP1_SIDE_EFFECT_TAG_LABEL_KEYS[key];
      expect(labelKey, `${key} has no label key`).toBeTruthy();
      for (const locale of locales) {
        expect(
          resolveKey(bundle(locale), labelKey),
          `${labelKey} missing from messages/${locale}.json`,
        ).toBeTruthy();
      }
    }
  });

  it("folds no two catalogue entries onto the same index row", () => {
    // A collision would make one symptom shadow another. Cheap to assert, and
    // the only way a new locale can break the index.
    const index = glp1SideEffectTagIndex();
    const byKey = new Map<string, string[]>();
    for (const [folded, key] of index) {
      byKey.set(key, [...(byKey.get(key) ?? []), folded]);
    }
    expect([...byKey.keys()].sort()).toEqual(
      [...GLP1_SIDE_EFFECT_TAG_KEYS].sort(),
    );
    // Every catalogue entry carries at least its own key plus the six labels
    // it ships under, minus whatever two locales happen to spell identically.
    for (const key of GLP1_SIDE_EFFECT_TAG_KEYS) {
      expect(
        (byKey.get(key) ?? []).length,
        `${key} resolves from too few spellings — a locale is missing`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("covers a locale the day it is added, with no edit here", () => {
    // The property that closes the class: every locale in `locales` has its
    // labels in the index already. Adding messages/xx.json and listing it in
    // `locales` is the whole change.
    const index = glp1SideEffectTagIndex();
    for (const locale of locales) {
      for (const { key, labelKey } of GLP1_SIDE_EFFECT_TAGS) {
        const label = resolveKey(bundle(locale), labelKey) as string;
        expect(index.get(normaliseSideEffectTag(label))).toBe(key);
      }
    }
  });
});
