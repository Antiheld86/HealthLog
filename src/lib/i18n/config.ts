export const locales = ["de", "en", "fr", "es", "it", "pl", "ko"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

/**
 * Narrow an arbitrary stored / request-supplied string to a shipped locale,
 * falling back to the app default.
 *
 * Background paths (the reminder worker, the Coach completion) historically
 * hand-rolled this as `locale === "en" || locale === "de" ? locale : default`,
 * which silently collapsed es / fr / it / pl to English even though their
 * bundles were complete. Route every such coercion through here so adding a
 * locale to `locales` is the only edit a new language needs.
 */
export function coerceLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * English name of each shipped language, for model-facing directives ("reply
 * in French"). Distinct from `localeLabels`, which is the endonym shown in the
 * language picker — a prompt directive has to be written in the prompt's own
 * language to be reliably followed.
 */
export const localeLanguageNames: Record<Locale, string> = {
  de: "German",
  en: "English",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pl: "Polish",
  ko: "Korean",
};

export const localeLabels: Record<Locale, string> = {
  de: "Deutsch",
  en: "English",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  pl: "Polski",
  ko: "한국어",
};

/**
 * v1.4.25 W9e — locales actively maintained by the project owner.
 * Locales outside this set are AI-initial translations and surface a
 * <MaintainershipBanner> notice at the top of the auth shell so users
 * know to expect rough edges and where to contribute fixes. Promoting
 * a locale here turns the banner off.
 */
const MAINTAINED_LOCALES: ReadonlySet<Locale> = new Set(["de", "en"]);

export function isMaintainedLocale(locale: Locale): boolean {
  return MAINTAINED_LOCALES.has(locale);
}
