import { describe, expect, it } from "vitest";

import { localeSites, localeFallbacks, parse } from "./helpers/narrated-locale";

/**
 * The guard checked against a guard.
 *
 * A structural check that cannot fail is worse than no check: it reads as
 * proof and is not. So each case below is a disguise someone would plausibly
 * reach for while putting the English default back — renaming the parameter,
 * aliasing the type, hiding the fallback behind a variable, defaulting the
 * whole options object instead of the field — and each one is asserted to be
 * caught by the SAME detector the real guard runs.
 *
 * These sources are strings on purpose. They are the shapes that must not
 * ship, so nothing here may live in a file the app can import.
 */

const FILE = "disguise.ts";

describe("the locale guard cannot be talked around", () => {
  it("catches the plain optional it was written for", () => {
    const [site] = localeSites(
      parse(
        FILE,
        `import type { Locale } from "@/lib/i18n/config";
         export function narrate(opts: { locale?: Locale }) { return opts; }`,
      ),
      "narrate",
    );
    expect(site.optional).toBe(true);
  });

  it("catches a renamed parameter — it reads the type, not the name", () => {
    const [site] = localeSites(
      parse(
        FILE,
        `import type { Locale } from "@/lib/i18n/config";
         export function narrate(opts: { lang?: Locale }) { return opts; }`,
      ),
      "narrate",
    );
    expect(site.where).toBe("opts.lang");
    expect(site.optional).toBe(true);
  });

  it("catches an aliased type import", () => {
    const [site] = localeSites(
      parse(
        FILE,
        `import type { Locale as L } from "@/lib/i18n/config";
         export function narrate(opts: { lang?: L }) { return opts; }`,
      ),
      "narrate",
    );
    expect(site.optional).toBe(true);
  });

  it("catches a required field on a DEFAULTED options object", () => {
    // The field says `locale: Locale`, so a field-only check reads as clean —
    // but `= {}` means the caller can still say nothing.
    const [site] = localeSites(
      parse(
        FILE,
        `import type { Locale } from "@/lib/i18n/config";
         export function narrate(opts: { locale: Locale } = {} as never) { return opts; }`,
      ),
      "narrate",
    );
    expect(site.hasInitializer).toBe(true);
  });

  it("catches a required field on an OPTIONAL options object", () => {
    const [site] = localeSites(
      parse(
        FILE,
        `import type { Locale } from "@/lib/i18n/config";
         export function narrate(opts?: { locale: Locale }) { return opts; }`,
      ),
      "narrate",
    );
    expect(site.optional).toBe(true);
  });

  it("catches an optional locale hidden in a same-file interface", () => {
    const [site] = localeSites(
      parse(
        FILE,
        `import type { Locale } from "@/lib/i18n/config";
         export interface Opts { period: string; locale?: Locale }
         export function narrate(opts: Opts) { return opts; }`,
      ),
      "narrate",
    );
    expect(site.optional).toBe(true);
  });

  it("catches a union that merely tolerates undefined", () => {
    const [site] = localeSites(
      parse(
        FILE,
        `import type { Locale } from "@/lib/i18n/config";
         export function narrate(opts: { locale?: Locale | undefined }) { return opts; }`,
      ),
      "narrate",
    );
    expect(site.optional).toBe(true);
  });

  it("refuses to pass a declaration that dropped the locale entirely", () => {
    expect(() =>
      localeSites(
        parse(
          FILE,
          `export function narrate(series: string[]) { return series; }`,
        ),
        "narrate",
      ),
    ).not.toThrow();
    expect(
      localeSites(
        parse(
          FILE,
          `export function narrate(series: string[]) { return series; }`,
        ),
        "narrate",
      ),
    ).toEqual([]); // the guard's own `length > 0` assertion is what fails on this
  });

  it("throws rather than quietly passing when the declaration is gone", () => {
    expect(() =>
      localeSites(parse(FILE, `export const x = 1;`), "narrate"),
    ).toThrow(/could not find/);
  });

  it("catches the default moved into a variable", () => {
    expect(
      localeFallbacks(
        parse(
          FILE,
          `const fallback = "en";
           export function narrate(opts: { locale?: string }) {
             return opts.locale ?? fallback;
           }`,
        ),
      ),
    ).not.toEqual([]);
  });

  it("catches the default written with || instead of ??", () => {
    expect(
      localeFallbacks(
        parse(
          FILE,
          `export const l = (o: { locale?: string }) => o.locale || "en";`,
        ),
      ),
    ).not.toEqual([]);
  });

  it("catches a renamed field's fallback when it still reads like a locale", () => {
    expect(
      localeFallbacks(
        parse(
          FILE,
          `export const l = (o: { readerLocale?: string }) => o.readerLocale ?? "en";`,
        ),
      ),
    ).not.toEqual([]);
  });

  it("does not fire on a fallback that has nothing to do with language", () => {
    // A guard that flags everything gets silenced, so it has to stay quiet
    // where it should.
    expect(
      localeFallbacks(
        parse(
          FILE,
          `export const n = (o: { minPairs?: number }) => o.minPairs ?? 20;`,
        ),
      ),
    ).toEqual([]);
  });
});
