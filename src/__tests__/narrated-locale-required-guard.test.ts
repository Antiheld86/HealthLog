import { describe, expect, it } from "vitest";

import { queryKeys } from "@/lib/query-keys";
import {
  CHAIN,
  WHY_NO_DEFAULT,
  localeFallbacks,
  localeSites,
  parse,
} from "./helpers/narrated-locale";

/**
 * A function that writes a sentence for a person must be told which language.
 *
 * The metric page's "Coach read" strip printed its own summary in German and
 * the pattern line under it in English, one under the other, for months. The
 * translations existed in all six languages the whole time. What broke was the
 * shape of the call: the discovery engine took `locale?: Locale` and fell back
 * to English, and the route that knew who was reading simply never said. Nobody
 * had to write anything wrong — staying quiet was enough, and the result read
 * like a finished sentence, so nothing looked broken from the code's side.
 *
 * A default is what made silence survivable. So on this chain there is none:
 * every locale a narrated sentence depends on is a REQUIRED parameter, and a
 * caller that cannot name one does not compile. This guard is what keeps that
 * true, because "optional with a sensible default" reads like a kindness every
 * time someone adds the next caller.
 *
 * It reads types, not names. Renaming the parameter, or lifting the default
 * into a variable, does not get past it — see the disguises in
 * `narrated-locale-guard-defeat.test.ts`, which run this same detector.
 */

describe("a narrated sentence's locale stays required", () => {
  for (const { file, declaration } of CHAIN) {
    it(`${declaration} (${file}) accepts a locale, and it is required`, () => {
      const sites = localeSites(parse(file), declaration);

      // Deleting the parameter must not pass as "nothing optional found".
      expect(
        sites.length,
        `${WHY_NO_DEFAULT}\n\n\`${declaration}\` no longer accepts a locale at ` +
          `all. It writes prose; it has to be told the language.`,
      ).toBeGreaterThan(0);

      for (const site of sites) {
        expect(
          site.optional,
          `${WHY_NO_DEFAULT}\n\nOptional locale at \`${declaration}\` → ${site.where}.`,
        ).toBe(false);
        expect(
          site.hasInitializer,
          `${WHY_NO_DEFAULT}\n\nDefaulted locale at \`${declaration}\` → ${site.where}.`,
        ).toBe(false);
      }
    });
  }

  for (const file of [...new Set(CHAIN.map((entry) => entry.file))]) {
    it(`${file} falls back to no language of its own`, () => {
      const fallbacks = localeFallbacks(parse(file));
      expect(
        fallbacks,
        `${WHY_NO_DEFAULT}\n\nA locale fallback in ${file}: ` +
          `${fallbacks.join(", ")}. Naming the fallback something else does ` +
          `not change what it does.`,
      ).toEqual([]);
    });
  }

  it("keys the strip's browser cache by language", () => {
    // The server-side fix is invisible to anyone who switches language rather
    // than reloads if the cached entry is shared across languages.
    const german = queryKeys.insightsCoachRead("WEIGHT", "de");
    const english = queryKeys.insightsCoachRead("WEIGHT", "en");
    expect(german).not.toEqual(english);
    expect(german).toContain("de");
    expect(english).toContain("en");
  });
});
