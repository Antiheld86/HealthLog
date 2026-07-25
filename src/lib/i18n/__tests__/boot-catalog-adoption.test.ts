import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Boot-catalog adoption — the client half of the i18n handoff.
 *
 * The root layout ships the active locale's catalog as a separate script
 * that assigns `self.__HL_I18N`; `load-locale` folds that global into its
 * cache so the FIRST client render resolves the same strings the server
 * rendered. When the fold happens at module-evaluation time it silently
 * depends on script ordering the module cannot see, and a catalog that
 * lands a moment late is lost for good — every `t()` in the hydration
 * render returns its raw key against the server's real text, which React
 * reports as a text hydration mismatch and the user sees as a frame of
 * `nav.skipToContent`.
 *
 * The invariant these tests pin is local and order-free: whatever the boot
 * script assigns is visible to the first read, whenever it lands.
 *
 * The tests run against a synthetic browser global — the suite's
 * environment is `node`, where `load-locale` takes its server branch and
 * seeds every catalog from `shared-resolve` instead.
 */

type BootGlobal = { locale?: string; messages?: Record<string, unknown> };

const EN_BOOT = { common: { save: "Save" } };

/**
 * Load a FRESH `load-locale` with `window` present, so the module takes
 * its browser branch and starts with an empty cache.
 */
async function importInBrowser() {
  vi.resetModules();
  return import("../load-locale");
}

function setBoot(boot: BootGlobal | undefined) {
  if (boot === undefined) {
    delete (globalThis as { __HL_I18N?: BootGlobal }).__HL_I18N;
    return;
  }
  (globalThis as { __HL_I18N?: BootGlobal }).__HL_I18N = boot;
}

beforeEach(() => {
  // `load-locale` branches on `window` and reads the global off `self`;
  // node has neither.
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { self?: unknown }).self = globalThis;
  setBoot(undefined);
});

afterEach(() => {
  setBoot(undefined);
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { self?: unknown }).self;
  vi.resetModules();
});

describe("i18n boot-catalog adoption", () => {
  it("adopts a catalog assigned AFTER the module was evaluated", async () => {
    const loadLocale = await importInBrowser();
    // Nothing yet — the boot script has not run.
    expect(loadLocale.getCachedMessages("en")).toBeUndefined();

    setBoot({ locale: "en", messages: EN_BOOT });

    // The regression: a module-evaluation snapshot returns undefined here
    // and the hydration render falls through to raw keys.
    expect(loadLocale.getCachedMessages("en")).toEqual(EN_BOOT);
    expect(loadLocale.getFallbackMessages()).toEqual(EN_BOOT);
  });

  it("adopts a catalog that was already assigned before evaluation", async () => {
    setBoot({ locale: "en", messages: EN_BOOT });
    const loadLocale = await importInBrowser();
    expect(loadLocale.getCachedMessages("en")).toEqual(EN_BOOT);
  });

  it("serves the boot catalog to loadMessages without a dynamic import", async () => {
    setBoot({ locale: "en", messages: EN_BOOT });
    const loadLocale = await importInBrowser();
    await expect(loadLocale.loadMessages("en")).resolves.toEqual(EN_BOOT);
  });

  it("never clobbers a bundle already in the cache", async () => {
    const loadLocale = await importInBrowser();
    const primed = { common: { save: "Primed" } };
    loadLocale.primeMessages("en", primed);

    setBoot({ locale: "en", messages: EN_BOOT });

    expect(loadLocale.getCachedMessages("en")).toEqual(primed);
  });

  it("ignores a malformed boot global and keeps asking", async () => {
    setBoot({ locale: "en" });
    const loadLocale = await importInBrowser();
    expect(loadLocale.getCachedMessages("en")).toBeUndefined();

    // A later, well-formed assignment still counts — the bad read must not
    // latch the adoption closed.
    setBoot({ locale: "en", messages: EN_BOOT });
    expect(loadLocale.getCachedMessages("en")).toEqual(EN_BOOT);
  });

  it("keys the catalog by the locale the boot script names", async () => {
    setBoot({ locale: "de", messages: { common: { save: "Speichern" } } });
    const loadLocale = await importInBrowser();
    expect(loadLocale.getCachedMessages("de")).toEqual({
      common: { save: "Speichern" },
    });
    expect(loadLocale.getCachedMessages("en")).toBeUndefined();
    expect(loadLocale.getFallbackMessages()).toBeUndefined();
  });
});
